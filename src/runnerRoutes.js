import express from 'express';
import http from 'http';
import { findFreePort } from './portManager.js';
import { createWorkspace, destroyWorkspace, writeFileToWorkspace, isValidSlug, isValidSessionId } from './workspaceManager.js';
import { startContainer, stopContainer, getContainerLogs, getActiveContainerCount, getAllSessions, activeSessions } from './dockerManager.js';
import { SERVER_HOST, MAX_CONTAINERS } from './config.js';

const router = express.Router();

function isHttpReachable(host, port, timeout = 3000) {
    return new Promise((resolve) => {
        const options = {
            hostname: host === 'localhost' ? '127.0.0.1' : host,
            port,
            path: '/',
            method: 'GET',
            timeout,
        };
        const req = http.request(options, (res) => {
            resolve(res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

router.post('/run-project', async (req, res) => {
    const { slug } = req.body;

    console.log(`\n[RunProject] Request received -> slug: "${slug}"`);

    if (!slug || !isValidSlug(slug)) {
        return res.status(400).json({ error: 'Invalid or missing slug' });
    }

    const activeCount = getActiveContainerCount();
    if (activeCount >= MAX_CONTAINERS) {
        console.warn(`[RunProject] Container limit reached (${activeCount}/${MAX_CONTAINERS})`);
        return res.status(429).json({
            error: `Maximum concurrent projects reached (${MAX_CONTAINERS}). Please stop an existing session first.`,
        });
    }

    let sessionId = null;
    let workspacePath = null;

    try {
        const workspace = await createWorkspace(slug);
        sessionId = workspace.sessionId;
        workspacePath = workspace.workspacePath;

        const hostPort = await findFreePort();
        if (!hostPort) {
            throw new Error('No available ports in the configured range. Try again later.');
        }
        console.log(`[RunProject] Assigned host port: ${hostPort}`);

        await startContainer(sessionId, workspacePath, hostPort, slug);

        const previewUrl = `http://${SERVER_HOST}:${hostPort}`;
        console.log(`[RunProject] ✓ Session ready -> ${previewUrl}`);

        return res.json({
            success: true,
            sessionId,
            previewUrl,
            port: hostPort,
            slug,
            message: 'Container is starting. The preview URL will be live in 10-20 seconds.',
        });

    } catch (err) {
        console.error(`[RunProject] ✗ Error:`, err.message);
        if (sessionId) {
            try { await destroyWorkspace(sessionId); } catch (_) {}
        }
        return res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/stop-project', async (req, res) => {
    const { sessionId } = req.body;

    console.log(`\n[StopProject] Request received -> sessionId: "${sessionId}"`);

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }

    const errors = [];

    try { await stopContainer(sessionId); }
    catch (err) { errors.push(`Container stop: ${err.message}`); }

    try { await destroyWorkspace(sessionId); }
    catch (err) { errors.push(`Workspace cleanup: ${err.message}`); }

    if (errors.length > 0) {
        console.warn(`[StopProject] Completed with warnings:`, errors);
        return res.status(207).json({
            success: false,
            warnings: errors,
            message: 'Session stopped with some errors.',
        });
    }

    console.log(`[StopProject] ✓ Session fully cleaned up: ${sessionId}`);
    return res.json({ success: true, message: `Session ${sessionId} stopped and cleaned up.` });
});

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
        console.log(`[SaveFile] ✓ File saved -> ${sessionId}/${filePath}`);
        return res.json({ success: true, message: 'File saved. Container will auto-reload.' });
    } catch (err) {
        console.error(`[SaveFile] ✗ Error:`, err.message);
        return res.status(err.status || 500).json({ error: err.message });
    }
});

router.get('/sessions', (req, res) => {
    const sessions = getAllSessions();
    return res.json({
        success: true,
        count: Object.keys(sessions).length,
        max: MAX_CONTAINERS,
        sessions,
    });
});

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

router.get('/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!sessionId || !isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found', ready: false });
    }

    const reachable = await isHttpReachable(SERVER_HOST === 'localhost' ? '127.0.0.1' : SERVER_HOST, session.port);

    console.log(`[Status] Session ${sessionId} -> port ${session.port} reachable: ${reachable}`);

    return res.json({
        ready: reachable,
        port: session.port,
        previewUrl: `http://${SERVER_HOST}:${session.port}`,
        sessionId,
    });
});

export default router;
