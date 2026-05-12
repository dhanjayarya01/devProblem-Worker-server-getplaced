import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from 'fs';

// Make folder name configurable. Remote server uses 'getplaced-codearena', local uses 'codearenaproject'
const projectsDir = process.env.PROJECTS_DIR_NAME || 'getplaced-codearena';

// Dynamically try to find the correct projects base path
let basePath = path.resolve(__dirname, '../../', projectsDir);
if (fs.existsSync(path.resolve(__dirname, '../../codearenaproject'))) {
    basePath = path.resolve(__dirname, '../../codearenaproject');
} else if (fs.existsSync(path.resolve(__dirname, '../../getplaced-codearena'))) {
    basePath = path.resolve(__dirname, '../../getplaced-codearena');
} else if (fs.existsSync(path.resolve(__dirname, '../../../getplaced-codearena'))) {
    // Handling the case where the repo was cloned inside a directory of the same name on the server
    basePath = path.resolve(__dirname, '../../../getplaced-codearena');
}

export const PROJECTS_BASE_PATH = basePath;
export const WORKSPACES_BASE_PATH = path.resolve(__dirname, '../../workspaces');
export const CONTAINER_INTERNAL_PORT = 3000;
export const PORT_RANGE_MIN = 4100;
export const PORT_RANGE_MAX = 5000;
export const MAX_CONTAINERS = 10;
export const SERVER_PORT = process.env.PORT || 5008;

// Preview subdomain base — sessions get https://{sessionId}.PREVIEW_DOMAIN
// Set PREVIEW_DOMAIN env var on server, e.g. PREVIEW_DOMAIN=getplaced.tech
export const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || 'getplaced.tech';
