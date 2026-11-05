import pg from 'pg';
import { validateDatabaseEnvironment } from './db-config.js';
import { loadBackendEnvironment } from './load-env.js';

loadBackendEnvironment();

const { Pool } = pg;
const databaseConfig = validateDatabaseEnvironment();

export const pool = new Pool({
  connectionString: databaseConfig.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: databaseConfig.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error', error);
});