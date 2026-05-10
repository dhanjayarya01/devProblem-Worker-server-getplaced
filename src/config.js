import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make folder name configurable. Remote server uses 'getplaced-codearena', local uses 'codearenaproject'
const projectsDir = process.env.PROJECTS_DIR_NAME || 'codearenaproject';
export const PROJECTS_BASE_PATH = path.resolve(__dirname, '../../', projectsDir);
export const WORKSPACES_BASE_PATH = path.resolve(__dirname, '../../workspaces');
export const CONTAINER_INTERNAL_PORT = 3000;
export const PORT_RANGE_MIN = 4100;
export const PORT_RANGE_MAX = 5000;
export const MAX_CONTAINERS = 10;
export const SERVER_PORT = process.env.PORT || 5008;

// Preview subdomain base — sessions get https://{sessionId}.PREVIEW_DOMAIN
// Set PREVIEW_DOMAIN env var on server, e.g. PREVIEW_DOMAIN=cinemasync.me
export const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || 'cinemasync.me';
