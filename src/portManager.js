import net from 'net';
import { execSync } from 'child_process';
import { PORT_RANGE_MIN, PORT_RANGE_MAX } from './config.js';

function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port);
    });
}

function getDockerUsedPorts() {
    try {
        const output = execSync('docker ps --format "{{.Ports}}"', { encoding: 'utf-8' });
        const usedPorts = new Set();
        const portPattern = /0\.0\.0\.0:(\d+)->/g;
        let match;
        while ((match = portPattern.exec(output)) !== null) {
            usedPorts.add(parseInt(match[1], 10));
        }
        return usedPorts;
    } catch (err) {
        console.warn('[Port] Could not query Docker ports:', err.message);
        return new Set();
    }
}

async function findFreePort() {
    const dockerPorts = getDockerUsedPorts();
    for (let port = PORT_RANGE_MIN; port <= PORT_RANGE_MAX; port++) {
        if (dockerPorts.has(port)) continue;
        const free = await isPortFree(port);
        if (free) return port;
    }
    return null;
}

export { findFreePort };
