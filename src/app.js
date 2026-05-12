import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { generateFileTree, getFileContent } from './filetree.js';
import runnerRoutes from './runnerRoutes.js';
import { PROJECTS_BASE_PATH, SERVER_PORT, PREVIEW_DOMAIN } from './config.js';
import { activeSessions, restoreSessionsFromDocker } from './dockerManager.js';

const app = express();

// ── TRUST PROXY — REQUIRED for Nginx ───────────────────────────────────────
app.set('trust proxy', true);

// ── CORS — allow frontend origin ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── DYNAMIC SUBDOMAIN PROXY ────────────────────────────────────────────────
const proxyCache = new Map();

app.use((req, res, next) => {
    const hostname = req.hostname || '';

    // Only intercept requests on *.PREVIEW_DOMAIN (e.g. session-abc.cinemasync.me)
    if (!hostname.endsWith(`.${PREVIEW_DOMAIN}`)) {
        return next(); // not a preview request — pass to API routes
    }

    const sessionId = hostname.slice(0, hostname.indexOf(`.${PREVIEW_DOMAIN}`));
    
    // Only log actual HTTP requests, skip logging noisy upgrade events
    if (!req.headers['upgrade']) {
        console.log(`[Proxy] Detected preview request for: ${hostname} (Session: ${sessionId})`);
    }

    if (!sessionId.startsWith('session-')) {
        return next(); // not a valid session subdomain
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        // Cleanup stale proxy from cache if it exists
        if (proxyCache.has(sessionId)) {
            proxyCache.delete(sessionId);
        }

        console.warn(`[Proxy] Unknown or expired session: ${sessionId}`);
        if (typeof res.status === 'function') {
            return res.status(404).send(`
                <h2>Session not found</h2>
                <p>Session <code>${sessionId}</code> has expired or does not exist.</p>
            `);
        } else if (res.writable) {
            // It's a socket (websocket upgrade), gracefully end
            return res.end();
        }
        return;
    }

    // Reuse existing proxy instance to prevent memory leak (MaxListenersExceededWarning)
    if (!proxyCache.has(sessionId)) {
        console.log(`[Proxy] Creating new proxy middleware for 127.0.0.1:${session.port}`);
        const proxy = createProxyMiddleware({
            target: `http://127.0.0.1:${session.port}`,
            changeOrigin: true,
            ws: true,
            on: {
                error: (err, req, res) => {
                    // These are all normal for Vite HMR/SSE — the client closes the
                    // connection before the proxy finishes writing. Suppress them.
                    const IGNORED = ['ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED'];
                    const isIgnored =
                        IGNORED.includes(err.code) ||
                        err.message === 'socket hang up' ||
                        err.message === 'write after end' ||
                        err.message?.includes('write EPIPE');

                    if (!isIgnored) {
                        console.error(`[Proxy] Error proxying to 127.0.0.1:${session.port}:`, err.message);
                    }

                    // If it's a normal Express response that hasn't been flushed yet, send 502
                    if (res && typeof res.headersSent === 'boolean') {
                        if (!res.headersSent && typeof res.status === 'function') {
                            try { res.status(502).send('Container not reachable yet.'); } catch (_) {}
                        }
                        return;
                    }

                    // Raw socket (WebSocket upgrade) — destroy safely
                    const socket = res?.socket ?? req?.socket;
                    if (socket && !socket.destroyed) {
                        try { socket.destroy(); } catch (_) {}
                    }
                },
            },
        });
        proxyCache.set(sessionId, proxy);
    }

    return proxyCache.get(sessionId)(req, res, next);
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

    let targetPath = problemPath;
    if (fs.existsSync(path.join(problemPath, 'template'))) {
        targetPath = path.join(problemPath, 'template');
    }

    const tree = generateFileTree(targetPath);
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

    const problemPath = path.join(PROJECTS_BASE_PATH, problem);
    let targetPath = problemPath;
    if (fs.existsSync(path.join(problemPath, 'template'))) {
        targetPath = path.join(problemPath, 'template');
    }

    const fullPath = path.join(targetPath, file);
    if (!fullPath.startsWith(targetPath)) {
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

// Manually route WebSocket upgrade requests to the correct dynamic proxy instance
httpServer.on('upgrade', (req, socket, head) => {
    const hostname = req.headers.host || '';
    
    // Only intercept requests for the preview domain
    if (hostname.endsWith(`.${PREVIEW_DOMAIN}`)) {
        const sessionId = hostname.slice(0, hostname.indexOf(`.${PREVIEW_DOMAIN}`));
        
        // If the proxy for this session exists, forward the websocket!
        if (proxyCache.has(sessionId)) {
            proxyCache.get(sessionId).upgrade(req, socket, head);
            return;
        }
    }
    
    // Drop the connection if session not found or invalid domain
    socket.destroy();
});

// Restore running docker containers into memory first, then start listening
restoreSessionsFromDocker().then(() => {
    httpServer.listen(SERVER_PORT, () => {
        console.log(`\n========================================================`);
        console.log(`🚀 Code Arena Worker running on http://localhost:${SERVER_PORT}`);
        console.log(`🌐 Preview domain: *.${PREVIEW_DOMAIN}`);
        console.log(`📂 Projects base: ${PROJECTS_BASE_PATH}`);
        console.log(`========================================================\n`);
    });
});
