const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Server } = require('@hocuspocus/server');
const multer = require('multer');
const archiver = require('archiver');

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
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // constant-time even on length mismatch
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

const generateKey = () => crypto.randomBytes(16).toString('hex');

// ─── APP SETUP ───────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
const ADMIN_KEY = process.env.VIVIDTEX_ADMIN_KEY || process.env.VIVIDTEX_PASSWORD;

if (!ADMIN_KEY) {
    console.warn('WARNING: No VIVIDTEX_ADMIN_KEY or VIVIDTEX_PASSWORD set. The system is open!');
}

const loadGroups = () => {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
        }
    } catch (e) { console.error('Failed to load groups.json:', e); }
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
    return (auth.projects || []).includes(projectName);
};

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
    if (req.path === '/api/auth/login') return next();

    if (!ADMIN_KEY) return next(); // No auth configured — open access

    const token = getToken(req);
    const auth = authenticateKey(token);
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

const hocuspocusServer = new Server({
    name: 'latex-collab',
    port: 1234,
    address: '0.0.0.0',
    async onAuthenticate({ token, documentName }) {
        const auth = authenticateKey(token);
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
hocuspocusServer.listen();

// ─── AUTH & ADMIN ENDPOINTS ──────────────────────────────

// Login: validate key, return role info
app.post('/api/auth/login', rateLimit(10, 60000), (req, res) => {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'Access key is required' });
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

// List all groups (admin only)
app.get('/api/admin/groups', requireAdmin, (req, res) => {
    const data = loadGroups();
    res.json(data.groups || {});
});

// Create a group (admin only)
app.post('/api/admin/groups', requireAdmin, (req, res) => {
    const { name, projects } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 50) {
        return res.status(400).json({ error: 'Valid group name is required (max 50 chars)' });
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
app.post('/api/projects/import', zipUpload.single('file'), (req, res) => {
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
        execFile('unzip', ['-o', req.file.path, '-d', finalDir], (error) => {
            // Clean up temp file
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            if (error) {
                try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (_) {}
                return res.status(500).json({ error: 'Failed to extract zip' });
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
        console.error('Error reading dir:', err);
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
    } catch (e) { console.error('detectMainTexFile error:', e); }
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

// Write file
app.post('/api/projects/:name/file', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        const filePath = safeJoin(projectDir, req.query.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, req.body.content);
        res.json({ success: true });
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

// Delete file or directory
app.delete('/api/projects/:name/file', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).send('Invalid project name');
    try {
        const projectDir = getProjectDir(name);
        const filePath = safeJoin(projectDir, req.query.path);
        if (filePath === projectDir) return res.status(400).json({ error: 'Cannot delete project root' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(403).json({ error: e.message });
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

app.post('/api/projects/:name/upload', tmpUpload.array('files', 50), (req, res) => {
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

// Compile project
app.post('/api/projects/:name/compile', (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    try {
        const projectDir = getProjectDir(name);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
        
        const mainTexFile = detectMainTexFile(projectDir);
        const mainTexBasename = path.basename(mainTexFile);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        execFile('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-f', '-pdflatex=pdflatex --no-shell-escape %O %S', mainTexBasename], { cwd: compileDir }, (error, stdout, stderr) => {
            const pdfPath = path.join(compileDir, pdfName);
            if (error && !fs.existsSync(pdfPath)) {
                console.error('Compilation Error:', error);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to compile LaTeX',
                    error: error.message,
                    stdout,
                    stderr 
                });
            }
            if (error) console.warn('Compilation completed with warnings:', error.message);
            console.log('Compilation successful:', stdout);
            res.json({ success: true, stdout, stderr, mainFile: mainTexFile, pdfName });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
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
    const safeFile = file.replace(/^(\.\.[\/\\])+/, '');
    try {
        const projectDir = getProjectDir(name);
        const mainTexFile = detectMainTexFile(projectDir);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        // Make the file path relative to compileDir
        const mainDir = path.dirname(mainTexFile);
        const relFile = mainDir === '.' ? safeFile : path.relative(mainDir, safeFile);
        const col = column || 0;
        execFile('synctex', ['view', '-i', `${line}:${col}:${relFile}`, '-o', pdfName], { cwd: compileDir }, (error, stdout) => {
            if (error) return res.status(500).json({ error: error.message });
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
    try {
        const projectDir = getProjectDir(name);
        const mainTexFile = detectMainTexFile(projectDir);
        const compileDir = getMainTexDir(projectDir, mainTexFile);
        const pdfName = getPdfName(mainTexFile);
        execFile('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfName}`], { cwd: compileDir }, (error, stdout) => {
            if (error) return res.status(500).json({ error: error.message });
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

// Clone a git repo as a new project
app.post('/api/projects/git-clone', async (req, res) => {
    const { url, name, branch } = req.body;
    if (!url || !isValidGitUrl(url)) {
        return res.status(400).json({ error: 'Invalid git URL. Use HTTPS or SSH format.' });
    }

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
        const cloneOpts = ['--depth', '1']; // shallow clone for speed
        if (branch) cloneOpts.push('--branch', branch);

        await simpleGit().clone(url, projectDir, cloneOpts);

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
        res.status(500).json({ error: 'Clone failed: ' + e.message });
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
        const log = await projectGit.log({ maxCount: 50 });
        res.json({ commits: log.all.map(c => ({
            hash: c.hash.substring(0, 7),
            fullHash: c.hash,
            message: c.message,
            author: c.author_name,
            date: c.date,
            refs: c.refs
        })) });
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
    const { message } = req.body;
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
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
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        // Unshallow if needed, then pull
        try { await projectGit.fetch(['--unshallow']); } catch (_) {}
        const result = await projectGit.pull();
        res.json({ success: true, summary: result.summary });
    } catch (e) {
        res.status(500).json({ error: 'Pull failed: ' + e.message });
    }
});

// Git push (push to remote)
app.post('/api/projects/:name/git/push', async (req, res) => {
    const { name } = req.params;
    if (!isValidProjectName(name)) return res.status(400).json({ error: 'Invalid project name' });
    const { setUpstream } = req.body;
    try {
        const projectDir = getProjectDir(name);
        const projectGit = simpleGit(projectDir);
        const branchResult = await projectGit.branch();
        const currentBranch = branchResult.current;
        if (setUpstream) {
            await projectGit.push(['--set-upstream', 'origin', currentBranch]);
        } else {
            await projectGit.push('origin', currentBranch);
        }
        res.json({ success: true, branch: currentBranch });
    } catch (e) {
        res.status(500).json({ error: 'Push failed: ' + e.message });
    }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.use((req, res) => res.sendFile(path.join(__dirname, "../frontend/dist/index.html")));

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend API running on http://0.0.0.0:${PORT}`);
    console.log(`Hocuspocus WebSocket running on ws://0.0.0.0:1234`);
    console.log(`Workspace directory: ${WORKDIR}`);
});
