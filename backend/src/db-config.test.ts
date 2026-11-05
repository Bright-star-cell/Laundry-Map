import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDatabaseEnvironment } from './db-config.js';

const productionDatabaseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://service:secret@postgres.example.com/laundry_map',
  DATABASE_SSL: 'true',
  REDIS_URL: 'rediss://:secret@redis.example.com:6380',
};

test('requires PostgreSQL TLS and authenticated TLS Redis in production', () => {
  assert.throws(() => validateDatabaseEnvironment({
    ...productionDatabaseEnvironment,
    DATABASE_SSL: 'false',
  }), /DATABASE_SSL/);
  assert.throws(() => validateDatabaseEnvironment({
    ...productionDatabaseEnvironment,
    REDIS_URL: 'redis://redis.example.com:6379',
  }), /REDIS_URL/);
  assert.throws(() => validateDatabaseEnvironment({
    ...productionDatabaseEnvironment,
    REDIS_URL: 'rediss://redis.example.com:6380',
  }), /REDIS_URL/);
});

test('validates database connection settings without production defaults', () => {
  assert.deepEqual(validateDatabaseEnvironment(productionDatabaseEnvironment), {
    DATABASE_URL: 'postgres://service:secret@postgres.example.com/laundry_map',
    DATABASE_SSL: 'true',
    REDIS_URL: 'rediss://:secret@redis.example.com:6380',
  });
  assert.throws(() => validateDatabaseEnvironment({ NODE_ENV: 'production' }), /DATABASE_URL/);
});