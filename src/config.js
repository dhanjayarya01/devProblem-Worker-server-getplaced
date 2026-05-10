import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECTS_BASE_PATH = path.resolve(__dirname, '../../codearenaproject');
export const WORKSPACES_BASE_PATH = path.resolve(__dirname, '../../workspaces');
export const CONTAINER_INTERNAL_PORT = 3000;
export const PORT_RANGE_MIN = 4100;
export const PORT_RANGE_MAX = 5000;
export const MAX_CONTAINERS = 3;
export const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
export const SERVER_PORT = process.env.PORT || 4000;
