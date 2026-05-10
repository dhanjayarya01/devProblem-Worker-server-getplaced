import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { MAX_CONTAINERS } from './config.js';

const execAsync = promisify(exec);

/** In-memory registry of active sessions. Map<sessionId, { port, containerId, slug }> */
export const activeSessions = new Map();

export function getActiveContainerCount() {
    return activeSessions.size;
}

export function getAllSessions() {
    const result = {};
    activeSessions.forEach((value, key) => { result[key] = value; });
    return result;
}

function isContainerRunning(containerName) {
    try {
        const output = execSync(
            `docker ps --filter "name=${containerName}" --format "{{.Names}}"`,
            { encoding: 'utf-8' }
        ).trim();
        return output.includes(containerName);
    } catch {
        return false;
    }
}

export async function startContainer(sessionId, workspacePath, hostPort, slug) {
    const normalizedPath = workspacePath.replace(/\\/g, '/');
    const nmVolumeName = `codearena-nm-${slug}`;

    const dockerCmd = [
        'docker run -d',
        `--name ${sessionId}`,
        `--restart unless-stopped`,
        `-p ${hostPort}:3000`,
        `-v "${normalizedPath}:/app"`,
        `-v "${nmVolumeName}:/app/node_modules"`,
        `-w /app`,
        `-e HOST=0.0.0.0`,
        `-e CHOKIDAR_USEPOLLING=true`,
        `-e CHOKIDAR_INTERVAL=1000`,
        `--memory="512m"`,
        `--cpus="0.5"`,
        `node:18`,
        `sh -c "npm install && npx vite --host 0.0.0.0 --port 3000"`,
    ].join(' ');

    console.log(`\n[Docker] Starting container for session: ${sessionId}`);
    console.log(`[Docker] Command: ${dockerCmd}`);

    try {
        const { stdout, stderr } = await execAsync(dockerCmd);
        const containerId = stdout.trim();

        if (stderr && !stderr.includes('WARNING')) {
            console.warn(`[Docker] stderr: ${stderr}`);
        }

        console.log(`[Docker] ✓ Container started. ID: ${containerId.slice(0, 12)}`);

        activeSessions.set(sessionId, {
            containerId,
            port: hostPort,
            slug,
            workspacePath,
            startedAt: new Date().toISOString(),
        });

        return containerId;
    } catch (err) {
        console.error(`[Docker] ✗ Failed to start container:`, err.message);
        throw new Error(`Docker failed to start: ${err.message}`);
    }
}

export async function stopContainer(sessionId) {
    const session = activeSessions.get(sessionId);

    if (!session) {
        console.warn(`[Docker] Session not found in registry: ${sessionId}`);
    }

    const containerName = sessionId;

    try {
        if (isContainerRunning(containerName)) {
            console.log(`[Docker] Stopping container: ${containerName}`);
            await execAsync(`docker stop ${containerName}`);
            console.log(`[Docker] ✓ Container stopped: ${containerName}`);
        }

        try {
            await execAsync(`docker rm ${containerName}`);
            console.log(`[Docker] ✓ Container removed: ${containerName}`);
        } catch {
            // Already removed — ignore
        }
    } catch (err) {
        console.error(`[Docker] ✗ Error stopping container ${containerName}:`, err.message);
        throw new Error(`Failed to stop container: ${err.message}`);
    } finally {
        activeSessions.delete(sessionId);
    }
}

export async function getContainerLogs(sessionId, tail = 50) {
    try {
        const { stdout } = await execAsync(`docker logs --tail ${tail} ${sessionId}`);
        return stdout;
    } catch (err) {
        throw new Error(`Could not fetch container logs: ${err.message}`);
    }
}
