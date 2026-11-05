import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db.js';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const initialSchema = new URL('../db/001_init.sql', import.meta.url);
const migrationLock = 731904221;

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
    await client.query(`CREATE TABLE IF NOT EXISTS laundry_map_schema_migrations (
      name TEXT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const files = (await readdir(migrationDirectory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    const migrations = [
      { name: '001_init.sql', sql: await readFile(initialSchema, 'utf8') },
      ...await Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), 'utf8') }))),
    ];
    const appliedResult = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM laundry_map_schema_migrations');
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.sha256.trim()]));

    if (applied.size === 0) {
      const existingSchema = await client.query<{ exists: boolean }>(`SELECT
        to_regclass('public.users') IS NOT NULL
        AND to_regclass('public.vendors') IS NOT NULL
        AND to_regclass('public.orders') IS NOT NULL
        AND to_regclass('public.order_items') IS NOT NULL
        AND to_regclass('public.order_status_history') IS NOT NULL
        AND to_regclass('public.payments') IS NOT NULL
        AND to_regclass('public.courier_locations') IS NOT NULL
        AND to_regclass('public.vendor_service_prices') IS NOT NULL AS exists`);
      if (existingSchema.rows[0].exists) {
        const baseline = migrations[0];
        const checksum = createHash('sha256').update(baseline.sql).digest('hex');
        await client.query('INSERT INTO laundry_map_schema_migrations (name, sha256) VALUES ($1, $2)', [baseline.name, checksum]);
        applied.set(baseline.name, checksum);
      }
    }

    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const priorChecksum = applied.get(migration.name);
      if (priorChecksum) {
        if (priorChecksum !== checksum) throw new Error(`Applied migration was modified: ${migration.name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO laundry_map_schema_migrations (name, sha256) VALUES ($1, $2)', [migration.name, checksum]);
        await client.query('COMMIT');
        console.info(JSON.stringify({ event: 'database_migration_applied', migration: migration.name }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]);
    } finally {
      client.release();
    }
  }
}

try {
  await runMigrations();
} finally {
  await pool.end();
}