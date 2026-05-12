import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { MAX_CONTAINERS, PREVIEW_DOMAIN } from './config.js';

const execAsync = promisify(exec);

/** In-memory registry. Map<sessionId, { sessionId, subdomain, port, containerId, slug, workspacePath, startedAt }> */
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

export async function restoreSessionsFromDocker() {
    try {
        const output = execSync('docker ps --format "{{.Names}}"').toString();
        const containers = output.split('\n').map(name => name.trim()).filter(Boolean);

        let restoredCount = 0;
        for (const containerName of containers) {
            if (containerName.startsWith('session-')) {
                const sessionId = containerName;
                try {
                    // Get port binding
                    const portOutput = execSync(`docker port ${sessionId} 3000`).toString().trim();
                    const match = portOutput.match(/(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
                    if (match) {
                        const port = parseInt(match[1], 10);
                        const subdomain = `${sessionId}.${PREVIEW_DOMAIN}`;
                        activeSessions.set(sessionId, {
                            sessionId,
                            subdomain,
                            containerId: sessionId,
                            port,
                            startedAt: new Date().toISOString(),
                        });
                        restoredCount++;
                        console.log(`[Restore] Restored session: ${sessionId} on port ${port}`);
                    }
                } catch (e) {
                    console.warn(`[Restore] Failed to get port for ${sessionId}`);
                }
            }
        }
        if (restoredCount > 0) {
            console.log(`[Restore] Successfully restored ${restoredCount} sessions from Docker.`);
        }
    } catch (e) {
        console.error(`[Restore] Failed to query docker containers:`, e.message);
    }
}

export async function startContainer(sessionId, workspacePath, hostPort, slug, runtimeEnvironment) {
    const normalizedPath = workspacePath.replace(/\\/g, '/');
    const nmVolumeName = `codearena-nm-${slug}`;

    // Apply defaults
    const baseImage = runtimeEnvironment?.baseImage || 'node:18';
    const entrypoint = runtimeEnvironment?.entrypoint || 'npm';
    const args = Array.isArray(runtimeEnvironment?.args) ? runtimeEnvironment.args : ['run', 'dev'];
    const installCommand = runtimeEnvironment?.installCommand || 'npm install';
    const port = runtimeEnvironment?.port || 3000;

    // Validate image against whitelist for security
    const allowedImages = ['node:18', 'node:20', 'python:3.10', 'openjdk:17', 'maven:3.8-eclipse-temurin-17', 'eclipse-temurin:17-jdk'];
    if (!allowedImages.includes(baseImage)) {
        throw new Error(`Base image ${baseImage} is not allowed for security reasons.`);
    }

    const startCmd = `${installCommand} && ${entrypoint} ${args.join(' ')}`;

    // ── Key change: bind to 127.0.0.1 only — port is NOT publicly accessible ──
    // All traffic comes via nginx → worker proxy → this port
    const dockerCmd = [
        'docker run -d',
        `--name ${sessionId}`,
        `--restart unless-stopped`,
        `-p 127.0.0.1:${hostPort}:${port}`,       // dynamic internal port
        `-v "${normalizedPath}:/app"`,
        `-v "${nmVolumeName}:/app/node_modules"`,
        `-w /app`,
        `-e HOST=0.0.0.0`,
        `-e CHOKIDAR_USEPOLLING=true`,
        `-e CHOKIDAR_INTERVAL=1000`,
        `--memory="512m"`,
        `--cpus="0.5"`,
        baseImage,
        `sh -c "${startCmd}"`,
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

        // Store full session info including the subdomain
        const subdomain = `${sessionId}.${PREVIEW_DOMAIN}`;
        activeSessions.set(sessionId, {
            sessionId,
            subdomain,
            containerId,
            port: hostPort,
            slug,
            workspacePath,
            testCommand: runtimeEnvironment?.testCommand || 'npm test',
            startedAt: new Date().toISOString(),
        });

        console.log(`[Docker] ✓ Preview subdomain: https://${subdomain}`);
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

export async function executeTest(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const { containerId, testCommand } = session;
    console.log(`\n[Docker Exec] Running tests for ${sessionId} using command: ${testCommand}`);

    try {
        const { stdout, stderr } = await execAsync(`docker exec ${containerId} sh -c "${testCommand}"`);
        console.log(`[Docker Exec] ✓ Tests completed for ${sessionId}`);
        return {
            success: true,
            logs: stdout + (stderr ? '\n' + stderr : '')
        };
    } catch (err) {
        console.warn(`[Docker Exec] ✗ Tests failed for ${sessionId}`);
        return {
            success: false,
            logs: (err.stdout || '') + (err.stderr ? '\n' + err.stderr : '') + '\n' + err.message
        };
    }
}
