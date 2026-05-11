import fs from 'fs';
import path from 'path';
import { WORKSPACES_BASE_PATH, PROJECTS_BASE_PATH } from './config.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function createSessionId() {
    const rand = Math.random().toString(36).slice(2, 7);
    return `session-${Date.now()}-${rand}`;
}

function getWorkspacePath(sessionId) {
    return path.join(WORKSPACES_BASE_PATH, sessionId);
}

function isValidSessionId(sessionId) {
    return /^session-[\w-]+$/.test(sessionId);
}

function isValidSlug(slug) {
    return /^[\w-]+$/.test(slug);
}

async function createWorkspace(slug) {
    const sourceDir = path.join(PROJECTS_BASE_PATH, slug);
    const templateDir = path.join(sourceDir, 'template');
    const hiddenTestsDir = path.join(sourceDir, 'hidden-tests');

    // Fallback: if 'template' folder doesn't exist, maybe it's an old project structure
    const isNewStructure = fs.existsSync(templateDir);
    const copyTarget = isNewStructure ? templateDir : sourceDir;

    if (!fs.existsSync(copyTarget)) {
        const err = new Error(`Problem slug "${slug}" not found on disk`);
        err.status = 404;
        throw err;
    }

    const sessionId = createSessionId();
    const workspacePath = getWorkspacePath(sessionId);

    fs.mkdirSync(WORKSPACES_BASE_PATH, { recursive: true });

    console.log(`[Workspace] Copying "${slug}" -> "${workspacePath}"`);
    copyDirSync(copyTarget, workspacePath);

    // If new structure and hidden-tests exists, overlay them directly into the workspace
    if (isNewStructure && fs.existsSync(hiddenTestsDir)) {
        console.log(`[Workspace] Injecting hidden tests for "${slug}"`);
        copyDirSync(hiddenTestsDir, workspacePath);
    }

    console.log(`[Workspace] ✓ Workspace created: ${sessionId}`);

    return { sessionId, workspacePath };
}

async function destroyWorkspace(sessionId) {
    const workspacePath = getWorkspacePath(sessionId);
    if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        console.log(`[Workspace] ✓ Removed workspace: ${sessionId}`);
    } else {
        console.warn(`[Workspace] Workspace not found on disk: ${sessionId}`);
    }
}

async function writeFileToWorkspace(sessionId, relativePath, content) {
    const workspacePath = getWorkspacePath(sessionId);
    const fullPath = path.join(workspacePath, relativePath);

    if (!fullPath.startsWith(workspacePath)) {
        const err = new Error('Invalid file path');
        err.status = 403;
        throw err;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`[Workspace] ✓ File written: ${sessionId}/${relativePath}`);
}

export {
    createWorkspace,
    destroyWorkspace,
    writeFileToWorkspace,
    getWorkspacePath,
    isValidSessionId,
    isValidSlug,
};
