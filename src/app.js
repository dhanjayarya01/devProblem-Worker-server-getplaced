import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { generateFileTree, getFileContent } from './filetree.js';
import runnerRoutes from './runnerRoutes.js';
import { PROJECTS_BASE_PATH, SERVER_PORT } from './config.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Docker Runner Routes ──────────────────────────────────────────────────
app.use('/', runnerRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        message: 'Code Arena Worker Server is running',
        endpoints: {
            fileTree: 'GET /api/tree/:slug',
            fileContent: 'GET /api/content?problem=SLUG&file=PATH',
            runProject: 'POST /run-project',
            stopProject: 'POST /stop-project',
            saveFile: 'POST /save-file',
            sessions: 'GET /sessions',
            logs: 'GET /logs/:sessionId',
            status: 'GET /status/:sessionId',
        }
    });
});

// ─── File Tree Route ───────────────────────────────────────────────────────
app.get('/api/tree/:slug', (req, res) => {
    const { slug } = req.params;

    console.log(`\n[+] File Tree request -> Project: "${slug}"`);

    if (!slug) {
        return res.status(400).json({ error: 'Problem slug is required' });
    }

    const problemPath = path.join(PROJECTS_BASE_PATH, slug);

    if (!problemPath.startsWith(PROJECTS_BASE_PATH)) {
        return res.status(403).json({ error: 'Invalid problem slug' });
    }

    if (!fs.existsSync(problemPath)) {
        console.log(`[-] Project "${slug}" not found. Checked: ${problemPath}`);
        return res.status(404).json({ error: `Problem directory '${slug}' not found` });
    }

    const tree = generateFileTree(problemPath);

    if (!tree) {
        console.log(`[-] Failed to generate tree for "${slug}"`);
        return res.status(500).json({ error: 'Failed to generate file tree' });
    }

    console.log(`[✓] File tree sent for: "${slug}"`);
    res.json({ problem: slug, tree });
});

// ─── File Content Route ────────────────────────────────────────────────────
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
        console.log(`[-] File "${file}" not found in project "${problem}"`);
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Requested path is a directory' });
    }

    const content = getFileContent(fullPath);
    if (content === null) {
        return res.status(500).json({ error: 'Failed to read file content' });
    }

    console.log(`[✓] File content sent: "${file}"`);
    res.json({ problem, file, content });
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(SERVER_PORT, () => {
    console.log(`\n========================================================`);
    console.log(`🚀 Code Arena Worker running on http://localhost:${SERVER_PORT}`);
    console.log(`📂 Projects base: ${PROJECTS_BASE_PATH}`);
    console.log(`========================================================\n`);
});
