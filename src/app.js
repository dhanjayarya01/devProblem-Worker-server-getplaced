import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { generateFileTree, getFileContent } from './filetree.js';
import runnerRoutes from './runnerRoutes.js';
import { PROJECTS_BASE_PATH, SERVER_PORT, PREVIEW_DOMAIN } from './config.js';
import { activeSessions } from './dockerManager.js';

const app = express();

// ── TRUST PROXY — REQUIRED for Nginx ───────────────────────────────────────
app.set('trust proxy', true);

// ── CORS — allow frontend origin ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── DYNAMIC SUBDOMAIN PROXY ────────────────────────────────────────────────
app.use((req, res, next) => {
    const hostname = req.hostname || '';

    // Only intercept requests on *.PREVIEW_DOMAIN (e.g. session-abc.cinemasync.me)
    if (!hostname.endsWith(`.${PREVIEW_DOMAIN}`)) {
        return next(); // not a preview request — pass to API routes
    }

    const sessionId = hostname.slice(0, hostname.indexOf(`.${PREVIEW_DOMAIN}`));
    console.log(`[Proxy] Detected preview request for: ${hostname} (Session: ${sessionId})`);

    if (!sessionId.startsWith('session-')) {
        return next(); // not a valid session subdomain
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        console.warn(`[Proxy] Unknown or expired session: ${sessionId}`);
        return res.status(404).send(`
            <h2>Session not found</h2>
            <p>Session <code>${sessionId}</code> has expired or does not exist.</p>
        `);
    }

    console.log(`[Proxy] Forwarding ${req.method} ${req.url} → 127.0.0.1:${session.port}`);

    // Dynamically create a proxy to the container's localhost port
    // ws: true enables WebSocket proxying (required for Vite HMR)
    const proxy = createProxyMiddleware({
        target: `http://127.0.0.1:${session.port}`,
        changeOrigin: true,
        ws: true,
        on: {
            error: (err, req, res) => {
                console.error(`[Proxy] Error proxying to port ${session.port}:`, err.message);
                if (!res.headersSent) {
                    res.status(502).send('Container is not reachable yet. Please wait a moment.');
                }
            },
        },
    });

    return proxy(req, res, next);
});

// ── API ROUTES ─────────────────────────────────────────────────────────────
// /run-project, /stop-project, /save-file, /sessions, /status/:id, /logs/:id
app.use('/', runnerRoutes);

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        message: 'Code Arena Worker Server is running',
        previewDomain: PREVIEW_DOMAIN,
        activeSessions: activeSessions.size,
        endpoints: {
            fileTree: 'GET /api/tree/:slug',
            fileContent: 'GET /api/content?problem=SLUG&file=PATH',
            runProject: 'POST /run-project',
            stopProject: 'POST /stop-project',
            saveFile: 'POST /save-file',
            sessions: 'GET /sessions',
            logs: 'GET /logs/:sessionId',
            status: 'GET /status/:sessionId',
        },
    });
});

// ── FILE TREE ROUTE ────────────────────────────────────────────────────────
app.get('/api/tree/:slug', (req, res) => {
    const { slug } = req.params;
    console.log(`\n[+] File Tree request -> Project: "${slug}"`);

    if (!slug) return res.status(400).json({ error: 'Problem slug is required' });

    const problemPath = path.join(PROJECTS_BASE_PATH, slug);
    if (!problemPath.startsWith(PROJECTS_BASE_PATH)) {
        return res.status(403).json({ error: 'Invalid problem slug' });
    }
    if (!fs.existsSync(problemPath)) {
        return res.status(404).json({ error: `Problem directory '${slug}' not found` });
    }

    const tree = generateFileTree(problemPath);
    if (!tree) return res.status(500).json({ error: 'Failed to generate file tree' });

    console.log(`[✓] File tree sent for: "${slug}"`);
    res.json({ problem: slug, tree });
});

// ── FILE CONTENT ROUTE ─────────────────────────────────────────────────────
app.get('/api/content', (req, res) => {
    const { problem, file } = req.query;
    console.log(`\n[+] File Content request -> Project: "${problem}", File: "${file}"`);

    if (!problem || !file) {
        return res.status(400).json({ error: "Both 'problem' and 'file' are required" });
    }

    const fullPath = path.join(PROJECTS_BASE_PATH, problem, file);
    if (!fullPath.startsWith(path.join(PROJECTS_BASE_PATH, problem))) {
        return res.status(403).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });

    const content = getFileContent(fullPath);
    if (content === null) return res.status(500).json({ error: 'Failed to read file' });

    console.log(`[✓] File content sent: "${file}"`);
    res.json({ problem, file, content });
});

// ── START SERVER ───────────────────────────────────────────────────────────
// Use createServer (not app.listen) so WebSocket upgrades are handled properly
// http-proxy-middleware needs access to the raw http.Server for ws:true to work
const httpServer = createServer(app);

httpServer.listen(SERVER_PORT, () => {
    console.log(`\n========================================================`);
    console.log(`🚀 Code Arena Worker running on http://localhost:${SERVER_PORT}`);
    console.log(`🌐 Preview domain: *.${PREVIEW_DOMAIN}`);
    console.log(`📂 Projects base: ${PROJECTS_BASE_PATH}`);
    console.log(`========================================================\n`);
});
