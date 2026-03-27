const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Server } = require('@hocuspocus/server');
const multer = require('multer');

const safeJoin = (base, target) => {
    const resolvedBase = path.resolve(base);
    const resolvedTarget = path.resolve(base, target);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) throw new Error('Path traversal');
    return resolvedTarget;
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (process.env.VIVIDTEX_PASSWORD) {
        const authHeader = req.headers.authorization;
        const queryToken = req.query.token;
        let token = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else if (queryToken) {
            token = queryToken;
        }

        if (token !== process.env.VIVIDTEX_PASSWORD) {
            return res.status(401).send('Unauthorized');
        }
    }
    next();
});

// Set up hocuspocus server
const hocuspocusServer = new Server({
    name: 'latex-collab',
    port: 1234, // This runs on a separate port for WebSockets
    address: '0.0.0.0', // Explicitly bind to IPv4
    async onAuthenticate({ token }) {
        if (process.env.VIVIDTEX_PASSWORD && token !== process.env.VIVIDTEX_PASSWORD) {
            throw new Error('Unauthorized');
        }
    }
});
hocuspocusServer.listen();

let WORKDIR = process.env.VIVIDTEX_WORKDIR || path.join(__dirname, '../../diplomarbeit');
if (!fs.existsSync(WORKDIR)) {
    fs.mkdirSync(WORKDIR, { recursive: true });
}

// Serve the workspace statically to allow direct access to images and media
app.use('/static', (req, res, next) => {
    express.static(WORKDIR)(req, res, next);
});

let git = simpleGit(WORKDIR);

// Optional: Check git repository in workspace
const initGit = async () => {
    try {
        const isRepo = await git.checkIsRepo();
        if (isRepo) {
            console.log('Git repository detected in workspace.');
        } else {
            console.log('No Git repository in workspace.');
        }
    } catch (e) {
        console.error('Failed to check git:', e);
    }
};
initGit();

app.get('/api/git/status', async (req, res) => {
    try {
        const isRepo = await git.checkIsRepo();
        res.json({ isRepo });
    } catch (e) {
        res.json({ isRepo: false });
    }
});

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // By default, save to media/images/ if it exists, otherwise root
        try {
            const targetDir = req.query.dir ? safeJoin(WORKDIR, req.query.dir) : path.join(WORKDIR, 'media', 'images');
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            cb(null, targetDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        cb(null, path.basename(file.originalname));
    }
});
const upload = multer({ storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    res.json({ success: true, message: 'File uploaded successfully', filename: req.file.originalname });
});

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
                // only add directory if it has relevant files
                if (children.length > 0) {
                    result.push({ name: file, type: 'directory', path: relativePath, children });
                }
            } else {
                if (/\.(tex|bib|cls|sty|txt|png|jpg|jpeg|gif|eps|pdf|svg)$/i.test(file)) {
                    result.push({ name: file, type: 'file', path: relativePath });
                }
            }
        }
    } catch (err) {
        console.error('Error reading dir:', err);
    }
    return result;
};

app.get('/api/tree', (req, res) => {
    res.json(getFiles(WORKDIR));
});

app.get('/api/file', (req, res) => {
    try {
        const filePath = safeJoin(WORKDIR, req.query.path);
        if (fs.existsSync(filePath)) {
            res.send(fs.readFileSync(filePath, 'utf-8'));
        } else {
            res.status(404).send('File not found');
        }
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

app.post('/api/file', (req, res) => {
    try {
        const filePath = safeJoin(WORKDIR, req.query.path);
        fs.writeFileSync(filePath, req.body.content);
        res.json({ success: true });
    } catch (e) {
        res.status(403).send('Forbidden');
    }
});

app.post('/api/compile', (req, res) => {
    const mainTexFile = 'main.tex';
    // Using latexmk with synctex, forcing it to keep going despite minor errors
    execFile('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-f', mainTexFile], { cwd: WORKDIR }, (error, stdout, stderr) => {
        if (error) {
            console.error('Compilation Error:', error);
            console.error('stderr:', stderr);
            return res.status(500).json({ 
                success: false, 
                message: 'Failed to compile LaTeX',
                error: error.message,
                stdout,
                stderr 
            });
        }
        console.log('Compilation successful:', stdout);
        res.json({ success: true, stdout, stderr });
    });
});

app.get('/api/pdf', (req, res) => {
    const pdfPath = path.join(WORKDIR, 'main.pdf');
    if (fs.existsSync(pdfPath)) {
        res.sendFile(pdfPath);
    } else {
        res.status(404).send('PDF not found');
    }
});

app.post('/api/synctex/view', (req, res) => {
    const { line, file } = req.body;
    if (!line || !file) return res.status(400).send('Missing line or file');

    // Remove any leading slash or path traversal from file
    const safeFile = file.replace(/^(\.\.[\/\\])+/, '');
    
    execFile('synctex', ['view', '-i', `${line}:0:${safeFile}`, '-o', 'main.pdf'], { cwd: WORKDIR }, (error, stdout) => {
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        // Parse synctex output
        // Output format contains e.g. "Page:4\nx:100\ny:200"
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
});

app.post('/api/synctex/edit', (req, res) => {
    const { page, x, y } = req.body;
    if (!page || x === undefined || y === undefined) return res.status(400).send('Missing page, x, or y');

    execFile('synctex', ['edit', '-o', `${page}:${x}:${y}:main.pdf`], { cwd: WORKDIR }, (error, stdout) => {
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        // Parse synctex output
        // Output format contains e.g. "Input:chapters/01_introduction.tex\nLine:15"
        const fileMatch = stdout.match(/Input:([^\n]+)/);
        const lineMatch = stdout.match(/Line:(\d+)/);
        
        if (fileMatch && lineMatch) {
            // Synctex might return absolute path or relative path
            let relativeFile = fileMatch[1].replace(WORKDIR + '/', '').replace(WORKDIR + '\\', '');
            if (relativeFile.startsWith('./')) relativeFile = relativeFile.substring(2);
            res.json({
                file: relativeFile,
                line: parseInt(lineMatch[1], 10)
            });
        } else {
            res.status(404).json({ error: 'No synctex result found' });
        }
    });
});

app.post('/api/git/commit', async (req, res) => {
    const { message } = req.body;
    try {
        await git.add('./*');
        await git.commit(message || 'Auto-commit from collaborative editor');
        try {
            await git.push('origin', 'LaTex', ['--set-upstream']);
        } catch (pushErr) {
            console.warn('Could not push to remote, it might not be configured:', pushErr.message);
        }
        res.json({ success: true, message: 'Committed successfully to LaTex branch' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.use((req, res) => res.sendFile(path.join(__dirname, "../frontend/dist/index.html")));

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend API running on http://0.0.0.0:${PORT}`);
    console.log(`Hocuspocus WebSocket running on ws://0.0.0.0:1234`);
});
