import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'laundry-map-config-test-secret-with-more-than-32-characters';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';

const { validateRuntimeEnvironment } = await import('./config.js');

const validProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'production-secret-value-with-at-least-thirty-two-characters',
  WEB_ORIGIN: 'https://laundry.example.com',
  NEXT_PUBLIC_API_URL: 'https://api.laundry.example.com',
  TRUST_PROXY: '1',
};

test('requires a JWT secret with at least 32 characters', () => {
  assert.throws(() => validateRuntimeEnvironment({
    ...validProductionEnvironment,
    JWT_SECRET: 'too-short',
  }), /JWT_SECRET/);
});

test('requires HTTPS origins and a trusted proxy setting in production', () => {
  assert.throws(() => validateRuntimeEnvironment({
    ...validProductionEnvironment,
    WEB_ORIGIN: 'http://laundry.example.com',
  }), /WEB_ORIGIN/);
  assert.throws(() => validateRuntimeEnvironment({
    ...validProductionEnvironment,
    NEXT_PUBLIC_API_URL: 'http://api.laundry.example.com',
  }), /NEXT_PUBLIC_API_URL/);
  const missingProxy = { ...validProductionEnvironment };
  delete missingProxy.TRUST_PROXY;
  assert.throws(() => validateRuntimeEnvironment(missingProxy), /TRUST_PROXY/);
});

test('accepts a valid production origin and normalizes proxy hop counts', () => {
  const config = validateRuntimeEnvironment(validProductionEnvironment);
  assert.deepEqual(config.WEB_ORIGIN, ['https://laundry.example.com']);
  assert.equal(config.NEXT_PUBLIC_API_URL, 'https://api.laundry.example.com');
  assert.equal(config.TRUST_PROXY, 1);
  assert.deepEqual(config.socketTransports, ['websocket', 'polling']);
});