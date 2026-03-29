const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Hocuspocus } = require('@hocuspocus/server');
const multer = require('multer');
const archiver = require('archiver');
const winston = require('winston');
require('winston-daily-rotate-file');

// ─── LOGGING ─────────────────────────────────────────────

const logDir = path.resolve(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
        `${timestamp} [${level.toUpperCase()}] ${stack || message}`
    )
);

const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'vividtex-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            zippedArchive: true,
        }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '60d',
            zippedArchive: true,
            level: 'error',
        }),
    ],
});

// ─── SECURITY HELPERS ────────────────────────────────────

const safeJoin = (base, target) => {
    const resolvedBase = path.resolve(base);
    const resolvedTarget = path.resolve(base, target);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) throw new Error('Path traversal');
    return resolvedTarget;
};

const isValidProjectName = (name) => /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 100;

// Timing-safe string comparison (prevents timing attacks on key guessing)
const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
};

const generateKey = () => crypto.randomBytes(16).toString('hex');

// ─── APP SETUP ───────────────────────────────────────────

const app = express();
const ALLOWED_CORS_ORIGINS = (process.env.VIVIDTEX_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
            origin === 'http://localhost:5173'
            || origin === 'http://127.0.0.1:5173'
            || origin === 'http://localhost:3001'
            || origin === 'http://127.0.0.1:3001'
        ) {
            return callback(null, true);
        }
        if (ALLOWED_CORS_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        // Do not throw, otherwise disallowed origins become 500 responses.
        return callback(null, false);
    }
}));
app.use(express.json({ limit: '5mb' }));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-src 'self' blob:");
    next();
});

// ─── WORKSPACE SETUP ─────────────────────────────────────

let WORKDIR = process.env.VIVIDTEX_WORKDIR || path.join(__dirname, '../../workspace');
if (!fs.existsSync(WORKDIR)) {
    fs.mkdirSync(WORKDIR, { recursive: true });
}

const getProjectDir = (projectName) => {
    if (!isValidProjectName(projectName)) throw new Error('Invalid project name');
    return safeJoin(WORKDIR, projectName);
};

// ─── GROUP-BASED ACCESS CONTROL ──────────────────────────

const GROUPS_FILE = path.join(WORKDIR, '.vividtex-groups.json');
let ADMIN_KEY = process.env.VIVIDTEX_ADMIN_KEY || process.env.VIVIDTEX_PASSWORD;

if (!ADMIN_KEY) {
    logger.warn('No VIVIDTEX_ADMIN_KEY set — the system is open! Set one in .env or restart to auto-generate.');
}

const loadGroups = () => {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
        }
    } catch (e) { logger.error('Failed to load groups.json:', e); }
    return { groups: {} };
};

const saveGroups = (data) => {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2));
};

// Returns { role: 'admin' } or { role: 'group', group, projects } or null
const authenticateKey = (key) => {
    if (!key) return null;
    if (ADMIN_KEY && safeCompare(key, ADMIN_KEY)) {
        return { role: 'admin' };
    }
    const data = loadGroups();
    for (const [groupName, groupData] of Object.entries(data.groups || {})) {
        if (safeCompare(key, groupData.key)) {
            return { role: 'group', group: groupName, projects: groupData.projects || [] };
        }
    }
    return null;
};

const hasProjectAccess = (auth, projectName) => {
    if (!auth) return false;
    if (auth.role === 'admin') return true;
    if (auth.role === 'ldap') return true; // LDAP users have access to all projects
    return (auth.projects || []).includes(projectName);
};

// ─── LDAP AUTHENTICATION ─────────────────────────────────

const LDAP_URL = process.env.VIVIDTEX_LDAP_URL || '';
const LDAP_BASE_DN = process.env.VIVIDTEX_LDAP_BASE_DN || '';
const LDAP_USER_FILTER = process.env.VIVIDTEX_LDAP_USER_FILTER || '(sAMAccountName={{username}})';
const LDAP_BIND_DN = process.env.VIVIDTEX_LDAP_BIND_DN || '';
const LDAP_BIND_PASSWORD = process.env.VIVIDTEX_LDAP_BIND_PASSWORD || '';
const LDAP_GROUP = process.env.VIVIDTEX_LDAP_GROUP || ''; // optional: restrict to group members
const LDAP_ADMIN_GROUP = process.env.VIVIDTEX_LDAP_ADMIN_GROUP || ''; // optional: LDAP group for admin role

const ldapEnabled = !!(LDAP_URL && LDAP_BASE_DN);

const authenticateLdap = (username, password) => {
    return new Promise((resolve, reject) => {
        if (!ldapEnabled) return reject(new Error('LDAP not configured'));
        if (!username || !password) return reject(new Error('Username and password required'));

        const ldap = require('ldapjs');
        const client = ldap.createClient({ url: LDAP_URL, tlsOptions: { rejectUnauthorized: false } });

        const bindDn = LDAP_BIND_DN || `${username}@${LDAP_BASE_DN.replace(/,?dc=/gi, '.').replace(/^\./, '')}`;
        const bindPwd = LDAP_BIND_DN ? LDAP_BIND_PASSWORD : password;

        // Step 1: Bind with service account (or user directly if no bind DN)
        client.bind(bindDn, bindPwd, (err) => {
            if (err) {
                client.destroy();
                return reject(new Error('LDAP bind failed'));
            }

            const filter = LDAP_USER_FILTER.replace('{{username}}', username.replace(/[()\\*]/g, ''));
            const opts = {
                filter,
                scope: 'sub',
                attributes: ['dn', 'cn', 'sAMAccountName', 'mail', 'memberOf', 'displayName'],
                sizeLimit: 1,
            };

            // Step 2: Search for the user
            client.search(LDAP_BASE_DN, opts, (err, searchRes) => {
                if (err) {
                    client.destroy();
                    return reject(new Error('LDAP search failed'));
                }

                let userEntry = null;
                searchRes.on('searchEntry', (entry) => {
                    userEntry = entry;
                });

                searchRes.on('error', (err) => {
                    client.destroy();
                    reject(new Error('LDAP search error'));
                });

                searchRes.on('end', () => {
                    if (!userEntry) {
                        client.destroy();
                        return reject(new Error('User not found'));
                    }

                    const userDn = userEntry.dn?.toString() || userEntry.objectName?.toString();
                    const attrs = {};
                    if (userEntry.ppiAttributes) {
                        for (const attr of userEntry.ppiAttributes) {
                            attrs[attr.type] = attr.values?.length === 1 ? attr.values[0] : attr.values;
                        }
                    } else if (userEntry.attributes) {
                        for (const attr of userEntry.attributes) {
                            attrs[attr.type] = attr.values?.length === 1 ? attr.values[0] : attr.values;
                        }
                    }

                    // Step 3: Rebind as the user to verify password (if we used a service account)
                    const verifyBind = LDAP_BIND_DN ? (cb) => {
                        const userClient = ldap.createClient({ url: LDAP_URL, tlsOptions: { rejectUnauthorized: false } });
                        userClient.bind(userDn, password, (err) => {
                            userClient.destroy();
                            cb(err);
                        });
                    } : (cb) => cb(null); // Already bound as user

                    verifyBind((err) => {
                        client.destroy();
                        if (err) return reject(new Error('Invalid password'));

                        const memberOf = Array.isArray(attrs.memberOf) ? attrs.memberOf : (attrs.memberOf ? [attrs.memberOf] : []);
                        const displayName = attrs.displayName || attrs.cn || username;

                        // Check group membership if required
                        if (LDAP_GROUP) {
                            const isMember = memberOf.some(g => g.toLowerCase().includes(LDAP_GROUP.toLowerCase()));
                            if (!isMember) return reject(new Error('Not a member of required group'));
                        }

                        // Check if user is an admin
                        let role = 'ldap';
                        if (LDAP_ADMIN_GROUP) {
                            const isAdmin = memberOf.some(g => g.toLowerCase().includes(LDAP_ADMIN_GROUP.toLowerCase()));
                            if (isAdmin) role = 'admin';
                        }

                        resolve({ role, username, displayName, memberOf });
                    });
                });
            });
        });
    });
};

// ─── LDAP SESSION STORE ──────────────────────────────────

const ldapSessions = new Map(); // token -> { role, username, displayName, expiresAt }
const LDAP_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

const createLdapSession = (ldapAuth) => {
    const token = `ldap_${generateKey()}`;
    ldapSessions.set(token, {
        role: ldapAuth.role,
        username: ldapAuth.username,
        displayName: ldapAuth.displayName,
        expiresAt: Date.now() + LDAP_SESSION_TTL,
    });
    return token;
};

const authenticateToken = (token) => {
    // Try key-based auth first
    const keyAuth = authenticateKey(token);
    if (keyAuth) return keyAuth;

    // Try LDAP session
    const session = ldapSessions.get(token);
    if (session) {
        if (Date.now() > session.expiresAt) {
            ldapSessions.delete(token);
            return null;
        }
        return { role: session.role === 'admin' ? 'admin' : 'ldap', username: session.username, displayName: session.displayName };
    }
    return null;
};

// Clean expired LDAP sessions every 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of ldapSessions) {
        if (now > session.expiresAt) ldapSessions.delete(token);
    }
}, 900000);

// ─── RATE LIMITING ───────────────────────────────────────

const rateLimits = new Map();

const rateLimit = (maxRequests, windowMs) => (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const routeKey = req.route?.path || req.path;
    const key = `${ip}:${routeKey}`;
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count++;
    rateLimits.set(key, entry);
    if (entry.count > maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
};

// Clean stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
        if (now > entry.resetAt) rateLimits.delete(key);
    }
}, 300000);

// ─── AUTH MIDDLEWARE ──────────────────────────────────────

const getToken = (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
    }
    return req.query.token || null;
};

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    // Static frontend files — no auth
    if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/assets/') || req.path.startsWith('/favicon.') || req.path.startsWith('/pdfjs/') || req.path === '/logo.png' || req.path === '/icons.svg') {
        return next();
    }

    // Login endpoint is public (has its own rate limit)
    if (req.path === '/api/auth/login' || req.path === '/api/auth/config') return next();

    if (!ADMIN_KEY && !ldapEnabled) return next(); // No auth configured — open access

    const token = getToken(req);
    const auth = authenticateToken(token);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });

    req.auth = auth;
    next();
});

// Per-project access control — fires for all routes with :name param
app.param('name', (req, res, next, name) => {
    if (!req.auth) return next(); // No auth configured
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    if (!hasProjectAccess(req.auth, name)) {
        return res.status(403).json({ error: 'Access denied to this project' });
    }
    next();
});

const requireAdmin = (req, res, next) => {
    if (!req.auth || req.auth.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// ─── HOCUSPOCUS (Real-time WebSocket collaboration) ──────

const hocuspocusServer = new Hocuspocus({
    name: 'latex-collab',
    async onAuthenticate({ token, documentName }) {
        const auth = authenticateToken(token);
        if (!auth) throw new Error('Unauthorized');

        // Document names are: latex::{project}::{file}
        const parts = (documentName || '').split('::');
        if (parts.length >= 2) {
            const projectName = parts[1];
            if (!hasProjectAccess(auth, projectName)) {
                throw new Error('Access denied to this project');
            }
        }
    }
});

// ─── AUTH & ADMIN ENDPOINTS ──────────────────────────────

// Login: validate key or LDAP credentials, return role info
app.post('/api/auth/login', rateLimit(10, 60000), async (req, res) => {
    const { key, username, password } = req.body;

    // LDAP login: username + password
    if (ldapEnabled && username && password) {
        try {
            const ldapAuth = await authenticateLdap(username, password);
            const token = createLdapSession(ldapAuth);
            return res.json({
                role: ldapAuth.role,
                group: null,
                projects: null,
                token,
                username: ldapAuth.displayName || ldapAuth.username,
                ldap: true,
            });
        } catch (e) {
            logger.warn(`LDAP login failed for ${username}: ${e.message}`);
            return res.status(401).json({ error: e.message || 'Invalid credentials' });
        }
    }

    // Key-based login
    if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: ldapEnabled ? 'Credentials required' : 'Access key is required' });
    }
    const auth = authenticateKey(key);
    if (!auth) {
        return res.status(401).json({ error: 'Invalid access key' });
    }
    if (auth.role === 'admin') {
        return res.json({ role: 'admin', group: null, projects: null });
    }
    return res.json({ role: auth.role, group: auth.group, projects: auth.projects });
});

// Check if LDAP is enabled (public endpoint for frontend)
app.get('/api/auth/config', (req, res) => {
    res.json({ ldap: ldapEnabled });
});

// List all groups (admin only)
app.get('/api/admin/groups', requireAdmin, (req, res) => {
    const data = loadGroups();
    res.json(data.groups || {});
});

// Create a group (admin only)
app.post('/api/admin/groups', requireAdmin, (req, res) => {
    const { name, projects } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 50 || !/^[a-zA-Z0-9 _-]+$/.test(name.trim())) {
        return res.status(400).json({ error: 'Valid group name required (alphanumeric, spaces, hyphens, underscores; max 50 chars)' });
    }
    const data = loadGroups();
    if (data.groups[name.trim()]) {
        return res.status(409).json({ error: 'Group already exists' });
    }
    const key = generateKey();
    data.groups[name.trim()] = { key, projects: Array.isArray(projects) ? projects : [] };
    saveGroups(data);
    res.json({ success: true, group: name.trim(), key });
});

// Update group project assignments (admin only)
app.put('/api/admin/groups/:groupName', requireAdmin, (req, res) => {
    const { groupName } = req.params;
    const { projects } = req.body;
    const data = loadGroups();
    if (!data.groups[groupName]) {
        return res.status(404).json({ error: 'Group not found' });
    }
    if (Array.isArray(projects)) data.groups[groupName].projects = projects;
    saveGroups(data);
    res.json({ success: true });
});

// Delete a group (admin only)
app.delete('/api/admin/groups/:groupName', requireAdmin, (req, res) => {
    const { groupName } = req.params;
    const data = loadGroups();
    if (!data.groups[groupName]) {
        return res.status(404).json({ error: 'Group not found' });
    }
    delete data.groups[groupName];
    saveGroups(data);
    res.json({ success: true });
});

// Regenerate key for a group (admin only)
app.post('/api/admin/groups/:groupName/regenerate-key', requireAdmin, (req, res) => {
    const { groupName } = req.params;
    const data = loadGroups();
    if (!data.groups[groupName]) {
        return res.status(404).json({ error: 'Group not found' });
    }
    data.groups[groupName].key = generateKey();
    saveGroups(data);
    res.json({ success: true, key: data.groups[groupName].key });
});

// ─── PROJECT MANAGEMENT ──────────────────────────────────

// List all projects (filtered by group access)
app.get('/api/projects', (req, res) => {
    try {
        const entries = fs.readdirSync(WORKDIR, { withFileTypes: true });
        let projects = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name }));
        // Groups can only see their assigned projects
        if (req.auth && req.auth.role === 'group') {
            const allowed = req.auth.projects || [];
            projects = projects.filter(p => allowed.includes(p.name));
        }
        res.json(projects);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create a new project (from scratch template)
app.post('/api/projects', (req, res) => {
    const { name } = req.body;
    if (!name || !isValidProjectName(name)) {
        return res.status(400).json({ error: 'Invalid project name. Use only letters, numbers, hyphens, and underscores.' });
    }
    try {
        const projectDir = getProjectDir(name);
        if (fs.existsSync(projectDir)) {
            return res.status(409).json({ error: 'Project already exists' });
        }
        fs.mkdirSync(projectDir, { recursive: true });
        // Create a starter main.tex
        const mainTex = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{${name.replace(/_/g, ' ').replace(/-/g, ' ')}}
\\author{Author}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`;
        fs.writeFileSync(path.join(projectDir, 'main.tex'), mainTex);
        // Auto-assign project to creator's group
        if (req.auth && req.auth.role === 'group') {
            const data = loadGroups();
            if (data.groups[req.auth.group]) {
                if (!data.groups[req.auth.group].projects.includes(name)) {
                    data.groups[req.auth.group].projects.push(name);
                    saveGroups(data);
                }
            }
        }
        res.json({ success: true, name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a project
app.delete('/api/projects/:name', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(projectDir)) {
            return res.status(404).json({ error: 'Project not found' });
        }
        fs.rmSync(projectDir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Export a project as zip
app.get('/api/projects/:name/export', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(projectDir)) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => res.status(500).json({ error: err.message }));
        archive.pipe(res);
        archive.directory(projectDir, false);
        archive.finalize();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Import a project from zip
const zipUpload = multer({ dest: '/tmp/vividtex-uploads/', limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/projects/import', rateLimit(10, 3600000), zipUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let projectName = req.body.name || path.basename(req.file.originalname, '.zip');
    // Sanitize name
    projectName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
    if (!projectName) projectName = 'imported-project';

    try {
        const projectDir = getProjectDir(projectName);

        // If project already exists, add a suffix
        let finalName = projectName;
        let counter = 1;
        let finalDir = projectDir;
        while (fs.existsSync(finalDir)) {
            finalName = `${projectName}_${counter}`;
            finalDir = getProjectDir(finalName);
            counter++;
        }

        fs.mkdirSync(finalDir, { recursive: true });

        // Extract zip using Node.js built-in or execFile unzip
        execFile('unzip', ['-o', req.file.path, '-d', finalDir], { timeout: 60000 }, (error) => {
            // Clean up temp file
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            if (error) {
                try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (_) {}
                return res.status(500).json({ error: 'Failed to extract zip' });
            }

            // Zip Slip protection: verify all extracted files are within finalDir
            const realFinalDir = fs.realpathSync(finalDir);
            const checkPaths = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = fs.realpathSync(path.join(dir, entry.name));
                    if (!fullPath.startsWith(realFinalDir)) {
                        throw new Error('Zip contains path traversal');
                    }
                    if (entry.isDirectory()) checkPaths(fullPath);
                }
            };
            try { checkPaths(finalDir); } catch (_) {
                try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (_2) {}
                return res.status(400).json({ error: 'Invalid zip: contains unsafe paths' });
            }

            // If the zip contains a single top-level folder, move contents up
            const entries = fs.readdirSync(finalDir);
            if (entries.length === 1) {
                const singleEntry = path.join(finalDir, entries[0]);
                if (fs.statSync(singleEntry).isDirectory()) {
                    const innerFiles = fs.readdirSync(singleEntry);
                    for (const f of innerFiles) {
                        const src = path.join(singleEntry, f);
                        const dest = path.join(finalDir, f);
                        fs.cpSync(src, dest, { recursive: true });
                    }
                    fs.rmSync(singleEntry, { recursive: true, force: true });
                }
            }

            // Auto-assign imported project to creator's group
            if (req.auth && req.auth.role === 'group') {
                const data = loadGroups();
                if (data.groups[req.auth.group]) {
                    if (!data.groups[req.auth.group].projects.includes(finalName)) {
                        data.groups[req.auth.group].projects.push(finalName);
                        saveGroups(data);
                    }
                }
            }
            res.json({ success: true, name: finalName });
        });
    } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        res.status(500).json({ error: e.message });
    }
});

// ─── PER-PROJECT ROUTES ──────────────────────────────────

// Serve project static files (images, media)
app.use('/api/projects/:name/static', (req, res, next) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        express.static(projectDir)(req, res, next);
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// File tree for a project
const getFiles = (dir, baseDir = '') => {
    const result = [];
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.startsWith('.')) continue; // ignore hidden
            
            const fullPath = path.join(dir, file);
            const relativePath = path.join(baseDir, file);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                const children = getFiles(fullPath, relativePath);
                result.push({ name: file, type: 'directory', path: relativePath, children });
            } else {
                if (/\.(tex|bib|cls|sty|txt|md|png|jpg|jpeg|gif|eps|pdf|svg)$/i.test(file)) {
                    result.push({ name: file, type: 'file', path: relativePath });
                }
            }
        }
    } catch (err) {
        logger.error('Error reading dir:', err);
    }
    return result;
};

// Recursively find all .tex files in a directory, returning paths relative to baseDir
const findTexFiles = (dir, baseDir = '') => {
    const results = [];
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith('.')) continue;
            const fullPath = path.join(dir, entry);
            const relPath = baseDir ? path.join(baseDir, entry) : entry;
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                results.push(...findTexFiles(fullPath, relPath));
            } else if (entry.endsWith('.tex')) {
                results.push(relPath);
            }
        }
    } catch (e) { /* ignore unreadable dirs */ }
    return results;
};

// Detect the main .tex file in a project (the one with \documentclass)
// Returns a path relative to projectDir (may include subdirectories)
const detectMainTexFile = (projectDir) => {
    try {
        const allTexFiles = findTexFiles(projectDir);
        // First pass: find a file with \documentclass (prioritize root-level files)
        const sorted = [...allTexFiles].sort((a, b) => {
            const aDepth = a.split(path.sep).length;
            const bDepth = b.split(path.sep).length;
            return aDepth - bDepth;
        });
        for (const f of sorted) {
            const content = fs.readFileSync(path.join(projectDir, f), 'utf-8');
            if (!content.trim()) continue; // skip empty files
            if (/^%\s*!TEX\s+root\s*=/mi.test(content)) continue;
            if (/^\s*\\documentclass/m.test(content)) return f;
        }
        // Fallback: main.tex at root if exists, else first .tex
        if (allTexFiles.includes('main.tex')) return 'main.tex';
        if (allTexFiles.length > 0) return sorted[0];
    } catch (e) { logger.error('detectMainTexFile error:', e); }
    return 'main.tex';
};

// Get the PDF name (same base name as main tex file)
const getPdfName = (mainTexFile) => path.basename(mainTexFile).replace(/\.tex$/i, '.pdf');

// Get the directory containing the main tex file (for cwd during compilation)
const getMainTexDir = (projectDir, mainTexFile) => {
    const dir = path.dirname(mainTexFile);
    return dir === '.' ? projectDir : path.join(projectDir, dir);
};

app.get('/api/projects/:name/tree', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
        const mainFile = detectMainTexFile(projectDir);
        res.json({ files: getFiles(projectDir), mainFile });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Read file
app.get('/api/projects/:name/file', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        const filePath = safeJoin(projectDir, req.query.path);
        if (fs.existsSync(filePath)) {
            res.send(fs.readFileSync(filePath, 'utf-8'));
        } else {
            res.status(404).send('File not found');
        }
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// Search across project files
app.get('/api/projects/:name/search', (req, res) => {
    const { name } = req.params;
    const query = req.query.q;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    if (!query || typeof query !== 'string' || query.length > 200) return res.status(400).json({ error: 'Invalid query' });
    try {
        const projectDir = getProjectDir(name);
        const results = [];
        const searchDir = (dir, baseDir = '') => {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.startsWith('.')) continue;
                const fullPath = path.join(dir, entry);
                const relativePath = baseDir ? path.join(baseDir, entry) : entry;
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    searchDir(fullPath, relativePath);
                } else if (/\.(tex|bib|cls|sty|txt|md)$/i.test(entry) && stat.size < 1048576) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const lines = content.split('\n');
                        const lowerQuery = query.toLowerCase();
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(lowerQuery)) {
                                results.push({ file: relativePath, line: i + 1, text: lines[i].trim().substring(0, 200) });
                                if (results.length >= 100) return;
                            }
                        }
                    } catch { /* skip unreadable files */ }
                }
            }
        };
        searchDir(projectDir);
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Write file
app.post('/api/projects/:name/file', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    if (!req.query.path || typeof req.query.path !== 'string') return res.status(400).json({ error: 'Missing file path' });
    if (!req.body || typeof req.body.content !== 'string') return res.status(400).json({ error: 'Missing file content' });
    try {
        const projectDir = getProjectDir(name);
        const filePath = safeJoin(projectDir, req.query.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, req.body.content);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save file' });
    }
});

// Delete file or directory (soft-delete: moves to .trash/)
app.delete('/api/projects/:name/file', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        const filePath = safeJoin(projectDir, req.query.path);
        if (filePath === projectDir) return res.status(400).json({ error: 'Cannot delete project root' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

        const trashDir = path.join(projectDir, '.trash');
        if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });

        const relativePath = path.relative(projectDir, filePath);
        const timestamp = Date.now();
        const trashName = `${timestamp}_${relativePath.replace(/[/\\]/g, '__')}`;
        const trashPath = path.join(trashDir, trashName);

        fs.renameSync(filePath, trashPath);
        res.json({ success: true, trashed: true });
    } catch (e) {
        res.status(403).json({ error: e.message });
    }
});

// List trash contents
app.get('/api/projects/:name/trash', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const trashDir = path.join(getProjectDir(name), '.trash');
        if (!fs.existsSync(trashDir)) return res.json([]);
        const items = fs.readdirSync(trashDir).map(entry => {
            const match = entry.match(/^(\d+)_(.+)$/);
            return {
                trashName: entry,
                originalPath: match ? match[2].replace(/__/g, '/') : entry,
                deletedAt: match ? Number(match[1]) : 0,
            };
        }).sort((a, b) => b.deletedAt - a.deletedAt);
        res.json(items);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Restore item from trash
app.post('/api/projects/:name/trash/restore', (req, res) => {
    const { name } = req.params;
    const { trashName } = req.body;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    if (!trashName || typeof trashName !== 'string') return res.status(400).json({ error: 'trashName required' });
    try {
        const projectDir = getProjectDir(name);
        const trashDir = path.join(projectDir, '.trash');
        const trashPath = safeJoin(trashDir, trashName);
        if (!fs.existsSync(trashPath)) return res.status(404).json({ error: 'Item not found in trash' });

        const match = trashName.match(/^(\d+)_(.+)$/);
        const originalRelative = match ? match[2].replace(/__/g, '/') : trashName;
        const restorePath = safeJoin(projectDir, originalRelative);
        const restoreDir = path.dirname(restorePath);
        if (!fs.existsSync(restoreDir)) fs.mkdirSync(restoreDir, { recursive: true });

        if (fs.existsSync(restorePath)) {
            return res.status(409).json({ error: 'A file already exists at the original path' });
        }
        fs.renameSync(trashPath, restorePath);
        res.json({ success: true, restoredTo: originalRelative });
    } catch (e) {
        res.status(403).json({ error: e.message });
    }
});

// Empty trash
app.delete('/api/projects/:name/trash', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const trashDir = path.join(getProjectDir(name), '.trash');
        if (fs.existsSync(trashDir)) fs.rmSync(trashDir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create folder in project
app.post('/api/projects/:name/folder', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { path: folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'Missing folder path' });
    try {
        const projectDir = getProjectDir(name);
        const fullPath = safeJoin(projectDir, folderPath);
        if (fs.existsSync(fullPath)) return res.status(409).json({ error: 'Folder already exists' });
        fs.mkdirSync(fullPath, { recursive: true });
        res.json({ success: true });
    } catch (e) {
        res.status(403).json({ error: e.message });
    }
});

// Upload files to project (supports folder structure via paths field)
const tmpUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024, files: 50 } });

app.post('/api/projects/:name/upload', rateLimit(30, 3600000), tmpUpload.array('files', 50), (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded' });
    }
    try {
        const projectDir = getProjectDir(name);
        const baseDir = req.query.dir ? safeJoin(projectDir, req.query.dir) : projectDir;
        // paths field contains the relative paths for each file (preserves folder structure)
        const rawPaths = req.body.paths;
        const paths = rawPaths ? (Array.isArray(rawPaths) ? rawPaths : [rawPaths]) : [];
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const relativePath = paths[i] || file.originalname;
            const targetPath = safeJoin(baseDir, relativePath);
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            fs.cpSync(file.path, targetPath);
            fs.unlinkSync(file.path);
        }
        res.json({ success: true, message: `${req.files.length} file(s) uploaded` });
    } catch (e) {
        // Clean up any remaining temp files
        for (const file of req.files) {
            try { fs.unlinkSync(file.path); } catch (_) {}
        }
        res.status(500).json({ error: e.message });
    }
});

// Move/rename file or folder within project
app.post('/api/projects/:name/move', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { source, destination } = req.body;
    if (!source) return res.status(400).json({ error: 'Missing source path' });
    if (destination === undefined || destination === null) return res.status(400).json({ error: 'Missing destination path' });
    try {
        const projectDir = getProjectDir(name);
        const srcPath = safeJoin(projectDir, source);
        // destination is a directory path (empty string = project root)
        const destDir = destination ? safeJoin(projectDir, destination) : projectDir;
        const destPath = path.join(destDir, path.basename(source));
        if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source not found' });
        if (!fs.existsSync(destDir)) return res.status(404).json({ error: 'Destination folder not found' });
        if (fs.existsSync(destPath)) return res.status(409).json({ error: 'Item already exists at destination' });
        // Prevent moving a folder into itself
        if (destPath.startsWith(srcPath + path.sep)) {
            return res.status(400).json({ error: 'Cannot move a folder into itself' });
        }
        fs.renameSync(srcPath, destPath);
        res.json({ success: true, newPath: path.relative(projectDir, destPath) });
    } catch (e) {
        res.status(403).json({ error: e.message });
    }
});

// Rename file or folder
app.post('/api/projects/:name/rename', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { filePath: fp, newName } = req.body;
    if (!fp || !newName) return res.status(400).json({ error: 'Missing filePath or newName' });
    if (/[/\\]/.test(newName) || newName === '.' || newName === '..') return res.status(400).json({ error: 'Invalid name' });
    try {
        const projectDir = getProjectDir(name);
        const srcPath = safeJoin(projectDir, fp);
        const destPath = path.join(path.dirname(srcPath), newName);
        if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });
        if (fs.existsSync(destPath)) return res.status(409).json({ error: 'A file with that name already exists' });
        fs.renameSync(srcPath, destPath);
        res.json({ success: true, newPath: path.relative(projectDir, destPath) });
    } catch (e) {
        res.status(403).json({ error: 'Rename failed' });
    }
});

// Compile project
app.post('/api/projects/:name/compile', rateLimit(30, 3600000), (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
        
        const mainTexFile = detectMainTexFile(projectDir);
        const mainTexBasename = path.basename(mainTexFile);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        execFile('latexmk', ['-norc', '-pdf', '-synctex=1', '-interaction=nonstopmode', '-f', '-pdflatex=pdflatex --no-shell-escape %O %S', mainTexBasename], { cwd: compileDir, timeout: 120000 }, (error, stdout, stderr) => {
            const pdfPath = path.join(compileDir, pdfName);
            if (error && !fs.existsSync(pdfPath)) {
                logger.error('Compilation error:', error);
                // Return log output so users can debug their LaTeX, but strip absolute paths
                const safeStdout = (stdout || '').replaceAll(compileDir, '.').replaceAll(projectDir, '.');
                const safeStderr = (stderr || '').replaceAll(compileDir, '.').replaceAll(projectDir, '.');
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to compile LaTeX',
                    stdout: safeStdout,
                    stderr: safeStderr 
                });
            }
            if (error) logger.warn('Compilation completed with warnings: %s', error.message);
            const safeStdout = (stdout || '').replaceAll(compileDir, '.').replaceAll(projectDir, '.');
            const safeStderr = (stderr || '').replaceAll(compileDir, '.').replaceAll(projectDir, '.');
            res.json({ success: true, stdout: safeStdout, stderr: safeStderr, mainFile: mainTexFile, pdfName });
        });
    } catch (e) {
        logger.error('Compilation error:', e);
        res.status(500).json({ error: 'Compilation failed' });
    }
});

// Get PDF
app.get('/api/projects/:name/pdf', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        const mainTexFile = detectMainTexFile(projectDir);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfPath = path.join(compileDir, getPdfName(mainTexFile));
        if (fs.existsSync(pdfPath)) {
            res.sendFile(pdfPath);
        } else {
            res.status(404).send('PDF not found');
        }
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// SyncTeX forward
app.post('/api/projects/:name/synctex/view', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    const { line, column, file } = req.body;
    if (!line || !file) return res.status(400).send('Missing line or file');
    if (!Number.isFinite(Number(line)) || (column !== undefined && !Number.isFinite(Number(column)))) return res.status(400).send('Invalid numeric parameters');
    try {
        const projectDir = getProjectDir(name);
        // Validate file path stays within project
        const safeFile = path.relative(projectDir, safeJoin(projectDir, file));
        const mainTexFile = detectMainTexFile(projectDir);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        // Make the file path relative to compileDir
        const mainDir = path.dirname(mainTexFile);
        const relFile = mainDir === '.' ? safeFile : path.relative(mainDir, safeFile);
        const col = column || 0;
        execFile('synctex', ['view', '-i', `${line}:${col}:${relFile}`, '-o', pdfName], { cwd: compileDir, timeout: 15000 }, (error, stdout) => {
            if (error) return res.status(500).json({ error: 'SyncTeX lookup failed' });
            const pageMatch = stdout.match(/Page:(\d+)/);
            const xMatch = stdout.match(/x:([\d.]+)/);
            const yMatch = stdout.match(/y:([\d.]+)/);
            const wMatch = stdout.match(/W:([\d.]+)/);
            const hMatch = stdout.match(/H:([\d.]+)/);
            if (pageMatch) {
                res.json({
                    page: parseInt(pageMatch[1], 10),
                    x: xMatch ? parseFloat(xMatch[1]) : 0,
                    y: yMatch ? parseFloat(yMatch[1]) : 0,
                    W: wMatch ? parseFloat(wMatch[1]) : 0,
                    H: hMatch ? parseFloat(hMatch[1]) : 0
                });
            } else {
                res.status(404).json({ error: 'No synctex result found' });
            }
        });
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// SyncTeX inverse
app.post('/api/projects/:name/synctex/edit', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    const { page, x, y } = req.body;
    if (!page || x === undefined || y === undefined) return res.status(400).send('Missing page, x, or y');
    if (!Number.isFinite(Number(page)) || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return res.status(400).send('Invalid numeric parameters');
    try {
        const projectDir = getProjectDir(name);
        const mainTexFile = detectMainTexFile(projectDir);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        execFile('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfName}`], { cwd: compileDir, timeout: 15000 }, (error, stdout) => {
            if (error) return res.status(500).json({ error: 'SyncTeX lookup failed' });
            const fileMatch = stdout.match(/Input:([^\n]+)/);
            const lineMatch = stdout.match(/Line:(\d+)/);
            const columnMatch = stdout.match(/Column:(-?\d+)/);
            if (fileMatch && lineMatch) {
                let relativeFile = fileMatch[1].replace(compileDir + '/', '').replace(compileDir + '\\', '');
                if (relativeFile.startsWith('./')) relativeFile = relativeFile.substring(2);
                // Make path relative to project root, not compile dir
                const mainDir = path.dirname(mainTexFile);
                if (mainDir !== '.') relativeFile = path.join(mainDir, relativeFile);
                res.json({ file: relativeFile, line: parseInt(lineMatch[1], 10), column: columnMatch ? parseInt(columnMatch[1], 10) : 0 });
            } else {
                res.status(404).json({ error: 'No synctex result found' });
            }
        });
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// ─── GIT INTEGRATION ─────────────────────────────────────

// Validate git URL: must be https:// or git@ (no file://, no command injection)
const isValidGitUrl = (url) => {
    if (typeof url !== 'string' || url.length > 500) return false;
    return /^https?:\/\/[^\s]+$/i.test(url) || /^git@[^\s:]+:[^\s]+$/i.test(url);
};

const GIT_HTTP_USERNAME = process.env.VIVIDTEX_GIT_USERNAME || '';
const GIT_HTTP_TOKEN = process.env.VIVIDTEX_GIT_TOKEN || process.env.VIVIDTEX_GIT_PASSWORD || '';

const isHttpsGitUrl = (url) => /^https?:\/\//i.test(url || '');

const normalizeGitCredential = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, 500);
};

const getGitCredentials = (req) => {
    const headerUsername = normalizeGitCredential(req.get('x-vividtex-git-username'));
    const headerToken = normalizeGitCredential(req.get('x-vividtex-git-token'));
    const token = headerToken || GIT_HTTP_TOKEN;
    const username = headerUsername || GIT_HTTP_USERNAME || (token ? 'git' : '');
    return { username, token, fromRequest: !!(headerUsername || headerToken) };
};

const buildAuthenticatedGitUrl = (url, credentials = {}) => {
    const username = credentials.username || GIT_HTTP_USERNAME || '';
    const token = credentials.token || GIT_HTTP_TOKEN || '';
    if (!isHttpsGitUrl(url) || !username || !token) return url;
    try {
        const parsed = new URL(url);
        if (parsed.password) return url;
        if (!parsed.username) parsed.username = username;
        parsed.password = token;
        return parsed.toString();
    } catch (_) {
        return url;
    }
};

const sanitizeGitMessage = (message, credentials = {}) => {
    if (!message) return 'Unknown git error';
    let sanitized = String(message).replace(/https?:\/\/([^@\s]+)@/gi, 'https://***@');
    [GIT_HTTP_USERNAME, GIT_HTTP_TOKEN, credentials.username, credentials.token].filter(Boolean).forEach((secret) => {
        sanitized = sanitized.split(secret).join('***');
    });
    return sanitized;
};

const isGitAuthFailure = (message) => {
    const text = String(message || '').toLowerCase();
    return text.includes('authentication')
        || text.includes('could not read username')
        || text.includes('terminal prompts disabled')
        || text.includes('permission denied (publickey)')
        || text.includes('permission denied');
};

const isGitPermissionFailure = (message) => {
    const text = String(message || '').toLowerCase();
    return (text.includes('permission to ') && text.includes(' denied to '))
        || text.includes('requested url returned error: 403')
        || text.includes('write access to repository not granted')
        || text.includes('not allowed to push to this repository');
};

const getGitAuthHint = (action, remoteUrl, credentials = {}) => {
    const verb = action.charAt(0).toUpperCase() + action.slice(1);
    if (isHttpsGitUrl(remoteUrl)) {
        if (credentials.username && credentials.token) {
            return `${verb} failed: Remote authentication was rejected. Check the Git username and personal access token saved in this browser.`;
        }
        if (GIT_HTTP_USERNAME && GIT_HTTP_TOKEN) {
            return `${verb} failed: Remote authentication was rejected. Check the configured server fallback credentials.`;
        }
        return `${verb} failed: Remote authentication required. Open Git Credentials in VividTex and enter your own Git username and personal access token.`;
    }
    return `${verb} failed: Remote authentication required. For SSH remotes, make an SSH key available inside the container or switch the remote to HTTPS with a token.`;
};

const getGitPermissionHint = (action, remoteUrl) => {
    const verb = action.charAt(0).toUpperCase() + action.slice(1);
    if (action === 'push') {
        return `${verb} failed: Your token authenticated successfully but does not have write access to this repository. Most likely your Personal Access Token is missing the required scope — for a classic PAT make sure the "repo" scope is checked; for a fine-grained PAT set "Contents" to "Read and write". If you are not the owner, ask to be added as a collaborator.`;
    }
    if (isHttpsGitUrl(remoteUrl)) {
        return `${verb} failed: Your Git account authenticated successfully, but it does not have access to this repository. Check repository permissions and org SSO authorization.`;
    }
    return `${verb} failed: The current Git identity does not have access to this repository.`;
};

const getGitRemoteInfo = async (projectGit, credentials = {}, preferredName = 'origin') => {
    const remotes = await projectGit.getRemotes(true);
    if (!remotes.length) return null;
    const remote = remotes.find((entry) => entry.name === preferredName) || remotes[0];
    const remoteUrl = remote.refs.push || remote.refs.fetch || '';
    return {
        name: remote.name,
        url: remoteUrl,
        authUrl: buildAuthenticatedGitUrl(remoteUrl, credentials),
    };
};

// Clone a git repo as a new project
app.post('/api/projects/git-clone', async (req, res) => {
    const { url, name, branch } = req.body;
    if (!url || !isValidGitUrl(url)) {
        return res.status(400).json({ error: 'Invalid git URL. Use HTTPS or SSH format.' });
    }
    const gitCredentials = getGitCredentials(req);

    // Derive project name from URL or use provided name
    let projectName = name || url.split('/').pop().replace(/\.git$/, '');
    projectName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
    if (!projectName) projectName = 'git-project';

    try {
        let finalName = projectName;
        let counter = 1;
        while (fs.existsSync(getProjectDir(finalName))) {
            finalName = `${projectName}_${counter}`;
            counter++;
        }

        const projectDir = getProjectDir(finalName);
        const cloneOpts = [];
        if (branch) cloneOpts.push('--branch', branch);

        await simpleGit().clone(buildAuthenticatedGitUrl(url, gitCredentials), projectDir, cloneOpts);

        // Auto-assign to creator's group
        if (req.auth && req.auth.role === 'group') {
            const data = loadGroups();
            if (data.groups[req.auth.group]) {
                if (!data.groups[req.auth.group].projects.includes(finalName)) {
                    data.groups[req.auth.group].projects.push(finalName);
                    saveGroups(data);
                }
            }
        }

        res.json({ success: true, name: finalName });
    } catch (e) {
        const message = sanitizeGitMessage(e.message, gitCredentials);
        if (isGitPermissionFailure(message)) {
            return res.status(400).json({ error: getGitPermissionHint('clone', url) });
        }
        if (isGitAuthFailure(message)) {
            return res.status(400).json({ error: getGitAuthHint('clone', url, gitCredentials) });
        }
        res.status(500).json({ error: 'Clone failed: ' + message });
    }
});

// Git status for a project (enhanced: includes remote info, branch, and all branches)
app.get('/api/projects/:name/git/status', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        const isRepo = await projectGit.checkIsRepo();
        if (!isRepo) return res.json({ isRepo: false });

        let branch = '';
        let hasRemote = false;
        let branches = { local: [], remote: [] };
        try {
            const branchResult = await projectGit.branch();
            branch = branchResult.current;
            branches.local = Object.keys(branchResult.branches).filter(b => !b.startsWith('remotes/'));
            const remotes = await projectGit.getRemotes();
            hasRemote = remotes.length > 0;
            if (hasRemote) {
                try { await projectGit.fetch(['--all']); } catch (_) {}
                const allBranches = await projectGit.branch(['-a']);
                branches.remote = Object.keys(allBranches.branches)
                    .filter(b => b.startsWith('remotes/'))
                    .map(b => b.replace(/^remotes\/origin\//, ''))
                    .filter(b => b !== 'HEAD' && !branches.local.includes(b));
            }
        } catch (_) {}

        res.json({ isRepo: true, branch, hasRemote, branches });
    } catch (e) {
        res.json({ isRepo: false });
    }
});

// Git diff (changed files)
app.get('/api/projects/:name/git/diff', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        const statusResult = await projectGit.status();
        const files = [
            ...statusResult.modified.map(f => ({ file: f, status: 'modified' })),
            ...statusResult.not_added.map(f => ({ file: f, status: 'new' })),
            ...statusResult.created.map(f => ({ file: f, status: 'new' })),
            ...statusResult.deleted.map(f => ({ file: f, status: 'deleted' })),
            ...statusResult.renamed.map(f => ({ file: f.to, status: 'renamed', from: f.from })),
        ];
        res.json({ files, staged: statusResult.staged });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Git log (recent commits)
app.get('/api/projects/:name/git/log', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);

        // Get structured log with parent info for graph rendering
        const log = await projectGit.log({ maxCount: 80, '--all': null });
        const commits = log.all.map(c => ({
            hash: c.hash.substring(0, 7),
            fullHash: c.hash,
            message: c.message,
            author: c.author_name,
            date: c.date,
            refs: c.refs
        }));

        // Get the actual graph output from git for visual rendering
        let graphLines = [];
        try {
            const DELIM = '<<GDELIM>>';
            const graphOutput = await projectGit.raw([
                'log', '--graph', '--all', '-80',
                `--format=${DELIM}%h${DELIM}`
            ]);
            graphLines = graphOutput.trim().split('\n').map(line => {
                const delimIdx = line.indexOf(DELIM);
                if (delimIdx !== -1) {
                    const graphPart = line.substring(0, delimIdx);
                    const hash = line.substring(delimIdx + DELIM.length, line.indexOf(DELIM, delimIdx + DELIM.length)) || '';
                    return { graph: graphPart, hash: hash.substring(0, 7) };
                }
                // Lines with only graph characters (merge lines etc)
                return { graph: line, hash: null };
            });
        } catch (_) {}

        res.json({ commits, graphLines });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Git checkout branch
app.post('/api/projects/:name/git/checkout', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { branch } = req.body;
    if (!branch || typeof branch !== 'string' || branch.length > 200) {
        return res.status(400).json({ error: 'Invalid branch name' });
    }
    // Sanitize branch name
    if (/[\x00-\x1f\x7f ~^:?*\[\\]/.test(branch) || branch.includes('..')) {
        return res.status(400).json({ error: 'Invalid branch name characters' });
    }
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        // If it's a remote branch like "origin/feature", create a local tracking branch
        const remotePrefixMatch = branch.match(/^([^/]+)\/(.+)$/);
        if (remotePrefixMatch) {
            const remoteName = remotePrefixMatch[1];
            const localName = remotePrefixMatch[2];
            // Check if a local branch with that name already exists
            const branchInfo = await projectGit.branch();
            if (branchInfo.all.includes(localName)) {
                await projectGit.checkout(localName);
            } else {
                await projectGit.checkoutBranch(localName, branch);
            }
        } else {
            await projectGit.checkout(branch);
        }
        const branchResult = await projectGit.branch();
        res.json({ success: true, branch: branchResult.current });
    } catch (e) {
        res.status(500).json({ error: 'Checkout failed: ' + e.message });
    }
});

// Git create branch
app.post('/api/projects/:name/git/create-branch', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { branch, checkout } = req.body;
    if (!branch || typeof branch !== 'string' || branch.length > 200) {
        return res.status(400).json({ error: 'Invalid branch name' });
    }
    if (/[\x00-\x1f\x7f ~^:?*\[\\]/.test(branch) || branch.includes('..')) {
        return res.status(400).json({ error: 'Invalid branch name characters' });
    }
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        if (checkout) {
            await projectGit.checkoutLocalBranch(branch);
        } else {
            await projectGit.branch([branch]);
        }
        const branchResult = await projectGit.branch();
        res.json({ success: true, branch: branchResult.current });
    } catch (e) {
        res.status(500).json({ error: 'Create branch failed: ' + e.message });
    }
});

// Git commit for a project
app.post('/api/projects/:name/git/commit', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { message, author } = req.body;
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        // Ensure git identity is set for this repo
        const authorName = author || (req.auth && req.auth.group) || 'VividTex User';
        try {
            await projectGit.addConfig('user.name', authorName);
            await projectGit.addConfig('user.email', `${authorName.replace(/\s+/g, '.')}@vividtex.local`);
        } catch (_) {}
        await projectGit.add('./*');
        await projectGit.commit(message || 'Auto-commit from VividTex');
        res.json({ success: true, message: 'Committed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Git pull (fetch latest from remote)
app.post('/api/projects/:name/git/pull', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const gitCredentials = getGitCredentials(req);
    let remoteInfo = null;
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        remoteInfo = await getGitRemoteInfo(projectGit, gitCredentials);
        if (!remoteInfo) {
            return res.status(400).json({ error: 'No remote configured. Add a remote first.' });
        }
        const branchResult = await projectGit.branch();
        const currentBranch = branchResult.current;
        // Unshallow if needed, then pull
        try {
            if (remoteInfo.authUrl !== remoteInfo.url) {
                await projectGit.raw(['fetch', '--unshallow', remoteInfo.authUrl]);
            } else {
                await projectGit.fetch(['--unshallow']);
            }
        } catch (_) {}
        const result = remoteInfo.authUrl !== remoteInfo.url
            ? await projectGit.pull(remoteInfo.authUrl, currentBranch)
            : await projectGit.pull();
        res.json({ success: true, summary: result.summary });
    } catch (e) {
        const message = sanitizeGitMessage(e.message, gitCredentials);
        if (isGitPermissionFailure(message)) {
            return res.status(400).json({ error: getGitPermissionHint('pull', remoteInfo && remoteInfo.url) });
        }
        if (isGitAuthFailure(message)) {
            return res.status(400).json({ error: getGitAuthHint('pull', remoteInfo && remoteInfo.url, gitCredentials) });
        }
        res.status(500).json({ error: 'Pull failed: ' + message });
    }
});

// Git push (push to remote)
app.post('/api/projects/:name/git/push', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const setUpstream = req.body && req.body.setUpstream;
    const gitCredentials = getGitCredentials(req);
    let remoteInfo = null;
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        remoteInfo = await getGitRemoteInfo(projectGit, gitCredentials);
        if (!remoteInfo) {
            return res.status(400).json({ error: 'No remote configured. Add a remote first.' });
        }
        const branchResult = await projectGit.branch();
        const currentBranch = branchResult.current;
        const pushTarget = remoteInfo.authUrl !== remoteInfo.url ? remoteInfo.authUrl : remoteInfo.name;
        // Check if branch has an upstream tracking branch
        let hasUpstream = false;
        try {
            const tracking = await projectGit.raw(['config', `branch.${currentBranch}.remote`]);
            hasUpstream = !!tracking.trim();
        } catch (_) {}

        if (setUpstream || !hasUpstream) {
            if (pushTarget === remoteInfo.name) {
                await projectGit.push(['--set-upstream', remoteInfo.name, currentBranch]);
            } else {
                await projectGit.push(pushTarget, `${currentBranch}:${currentBranch}`);
                await projectGit.addConfig(`branch.${currentBranch}.remote`, remoteInfo.name);
                await projectGit.addConfig(`branch.${currentBranch}.merge`, `refs/heads/${currentBranch}`);
            }
        } else {
            await projectGit.push(pushTarget, currentBranch);
        }
        res.json({ success: true, branch: currentBranch });
    } catch (e) {
        const msg = sanitizeGitMessage(e.message, gitCredentials);
        if (isGitPermissionFailure(msg)) {
            return res.status(400).json({ error: getGitPermissionHint('push', remoteInfo && remoteInfo.url) });
        }
        if (isGitAuthFailure(msg)) {
            return res.status(400).json({ error: getGitAuthHint('push', remoteInfo && remoteInfo.url, gitCredentials) });
        }
        if (msg.includes('no upstream') || msg.includes('has no upstream branch')) {
            return res.status(400).json({ error: 'no upstream branch' });
        }
        res.status(500).json({ error: 'Push failed: ' + msg });
    }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.use((req, res) => res.sendFile(path.join(__dirname, "../frontend/dist/index.html")));

const PORT = 3001;
const http = require('http');
const WebSocket = require('ws');
const httpServer = http.createServer(app);
const wss = new WebSocket.WebSocketServer({ noServer: true });

// Handle WebSocket upgrades for Hocuspocus on /ws path
httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            hocuspocusServer.handleConnection(ws, request);
        });
    } else {
        socket.destroy();
    }
});

httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info(`VividTex running on http://0.0.0.0:${PORT} (API + WebSocket)`);
    logger.info(`Workspace directory: ${WORKDIR}`);
});
