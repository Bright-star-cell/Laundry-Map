import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const backendEnvironmentFile = fileURLToPath(new URL('../.env', import.meta.url));

export function loadBackendEnvironment() {
  dotenv.config({ path: backendEnvironmentFile, override: false });
}