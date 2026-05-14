import express from 'express';
import http from 'http';
import { findFreePort } from './portManager.js';
import { createWorkspace, destroyWorkspace, writeFileToWorkspace, createWorkspaceItem, deleteWorkspaceItem, getWorkspacePath, isValidSlug, isValidSessionId } from './workspaceManager.js';
import { startContainer, stopContainer, executeTest, getContainerLogs, executeCommand, getActiveContainerCount, getAllSessions, activeSessions } from './dockerManager.js';
import { generateFileTree } from './filetree.js';
import { MAX_CONTAINERS, PREVIEW_DOMAIN } from './config.js';

const router = express.Router();

// ── Readiness check: hit the container's localhost port over HTTP ──────────
// TCP-only checks fire too early (during npm install). HTTP confirms Vite is up.
function isHttpReachable(port, timeout = 3000) {
    return new Promise((resolve) => {
        const req = http.request(
            { hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout },
            (res) => resolve(res.statusCode < 500)
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// ── POST /run-project ──────────────────────────────────────────────────────
router.post('/run-project', async (req, res) => {
    const { slug, runtimeEnvironment } = req.body;
    console.log(`\n[RunProject] Request received -> slug: "${slug}"`);

    if (!slug || !isValidSlug(slug)) {
        return res.status(400).json({ error: 'Invalid or missing slug' });
    }

    const activeCount = getActiveContainerCount();
    if (activeCount >= MAX_CONTAINERS) {
        console.warn(`[RunProject] Container limit reached (${activeCount}/${MAX_CONTAINERS})`);
        return res.status(429).json({
            error: `Maximum concurrent projects reached (${MAX_CONTAINERS}). Stop an existing session first.`,
        });
    }

    let sessionId = null;
    try {
        const workspace = await createWorkspace(slug);
        sessionId = workspace.sessionId;

        const hostPort = await findFreePort();
        if (!hostPort) throw new Error('No available ports. Try again later.');
        console.log(`[RunProject] Assigned host port: ${hostPort}`);

        await startContainer(sessionId, workspace.workspacePath, hostPort, slug, runtimeEnvironment);

        // Return the subdomain URL — no IP:PORT exposed to frontend
        const previewUrl = `https://${sessionId}.${PREVIEW_DOMAIN}`;
        console.log(`[RunProject] ✓ Session ready -> ${previewUrl}`);

        return res.json({
            success: true,
            sessionId,
            previewUrl,       // https://session-abc.cinemasync.me
            slug,
            message: 'Container starting. Preview URL will be live in ~15 seconds.',
        });

    } catch (err) {
        console.error(`[RunProject] ✗ Error:`, err.message);
        if (sessionId) {
            try { await destroyWorkspace(sessionId); } catch (_) {}
        }
        return res.status(err.status || 500).json({ error: err.message });
    }
});

// ── POST /run-tests ────────────────────────────────────────────────────────
router.post('/run-tests', async (req, res) => {
    const { sessionId } = req.body;
    console.log(`\n[RunTests] Request received -> sessionId: "${sessionId}"`);

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    try {
        const result = await executeTest(sessionId);
        return res.json(result);
    } catch (e) {
        console.error(`[RunTests] Error:`, e.message);
        return res.status(500).json({ error: e.message || 'Failed to run tests' });
    }
});

// ── POST /execute-command ──────────────────────────────────────────────────
router.post('/execute-command', async (req, res) => {
    const { sessionId, command } = req.body;
    
    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (!command) {
        return res.status(400).json({ error: 'command is required' });
    }

    try {
        const result = await executeCommand(sessionId, command);
        return res.json(result);
    } catch (err) {
        console.error(`[ExecuteCommand] Error:`, err.message);
        return res.status(err.status || 500).json({ error: err.message, success: false });
    }
});

// ── POST /stop-project ─────────────────────────────────────────────────────
router.post('/stop-project', async (req, res) => {
    const { sessionId } = req.body;
    console.log(`\n[StopProject] Request -> sessionId: "${sessionId}"`);

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }

    const errors = [];
    try { await stopContainer(sessionId); } catch (err) { errors.push(`Container: ${err.message}`); }
    try { await destroyWorkspace(sessionId); } catch (err) { errors.push(`Workspace: ${err.message}`); }

    if (errors.length > 0) {
        return res.status(207).json({ success: false, warnings: errors });
    }
    console.log(`[StopProject] ✓ Cleaned up: ${sessionId}`);
    return res.json({ success: true, message: `Session ${sessionId} stopped.` });
});

// ── POST /save-file ────────────────────────────────────────────────────────
router.post('/save-file', async (req, res) => {
    const { sessionId, filePath, content } = req.body;
    console.log(`\n[SaveFile] session: "${sessionId}", file: "${filePath}"`);

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (!filePath || typeof content === 'undefined') {
        return res.status(400).json({ error: 'filePath and content are required' });
    }

    try {
        await writeFileToWorkspace(sessionId, filePath, content);
        console.log(`[SaveFile] ✓ Saved -> ${sessionId}/${filePath}`);
        return res.json({ success: true, message: 'File saved. Container will auto-reload.' });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
});

// ── POST /workspace/create ─────────────────────────────────────────────────
router.post('/workspace/create', async (req, res) => {
    const { sessionId, filePath, isFolder } = req.body;
    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (!filePath) {
        return res.status(400).json({ error: 'filePath is required' });
    }

    try {
        await createWorkspaceItem(sessionId, filePath, isFolder);
        return res.json({ success: true, message: `${isFolder ? 'Folder' : 'File'} created successfully.` });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
});

// ── POST /workspace/delete ─────────────────────────────────────────────────
router.post('/workspace/delete', async (req, res) => {
    const { sessionId, filePath } = req.body;
    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (!filePath) {
        return res.status(400).json({ error: 'filePath is required' });
    }

    try {
        await deleteWorkspaceItem(sessionId, filePath);
        return res.json({ success: true, message: `Deleted successfully.` });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
});

// ── GET /workspace/tree/:sessionId ─────────────────────────────────────────
router.get('/workspace/tree/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }

    try {
        const workspacePath = getWorkspacePath(sessionId);
        const tree = generateFileTree(workspacePath);
        if (!tree) return res.status(500).json({ error: 'Failed to generate file tree from workspace' });
        
        return res.json({ sessionId, tree });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
});

// ── GET /sessions ──────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
    return res.json({
        success: true,
        count: activeSessions.size,
        max: MAX_CONTAINERS,
        sessions: getAllSessions(),
    });
});

// ── GET /logs/:sessionId ───────────────────────────────────────────────────
router.get('/logs/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const tail = parseInt(req.query.tail || '50', 10);

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }
    try {
        const logs = await getContainerLogs(sessionId, tail);
        return res.json({ success: true, sessionId, logs });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /status/:sessionId ─────────────────────────────────────────────────
// Frontend polls this after "Prepare to Run" until ready:true
router.get('/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found', ready: false });
    }

    // Always check 127.0.0.1 (port is localhost-only now)
    const ready = await isHttpReachable(session.port);
    console.log(`[Status] ${sessionId} -> port ${session.port} reachable: ${ready}`);

    return res.json({
        ready,
        sessionId,
        previewUrl: `https://${session.subdomain}`,  // subdomain URL
    });
});

// ── GET /sessions ────────────────────────────────────────────────────────────
// Admin dashboard: returns all active sessions with full metadata.
// For sessions started before startedAt tracking was added, we extract the
// Unix ms timestamp embedded in the session ID: session-{TS}-{RAND}
router.get('/sessions', (req, res) => {
    const sessions = {};
    activeSessions.forEach((session, sessionId) => {
        // Fallback: parse timestamp from the session ID itself
        const idTimestamp = parseInt(sessionId.split('-')[1]) || null;
        const startedAt   = session.startedAt   || idTimestamp;
        const lastBeat    = session.lastHeartbeat || startedAt;
        const now         = Date.now();
        const uptimeMs    = startedAt ? now - startedAt : null;
        const idleMs      = lastBeat  ? now - lastBeat  : null;

        sessions[sessionId] = {
            sessionId:     session.sessionId || sessionId,
            port:          session.port,
            subdomain:     session.subdomain,
            slug:          session.slug,
            startedAt,
            lastHeartbeat: lastBeat,
            tabHiddenAt:   session.tabHiddenAt || null,
            // Pre-computed for admin display (can still be computed client-side)
            uptimeMs,
            idleMs,
            tabHidden:     !!session.tabHiddenAt,
        };
    });
    return res.json({ ok: true, count: activeSessions.size, sessions });
});

export default router;
