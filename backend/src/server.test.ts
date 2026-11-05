import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { io as createClient, type Socket } from 'socket.io-client';
import { after, test } from 'node:test';

const testSecret = 'laundry-map-api-test-secret-with-more-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = testSecret;
process.env.DATABASE_URL = 'postgres://laundry:laundry@127.0.0.1:5432/laundry_map';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';

const { httpServer } = await import('./server.js');
const server = httpServer;
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address() as AddressInfo;
const apiUrl = `http://127.0.0.1:${address.port}`;
const customerToken = jwt.sign({ role: 'CUSTOMER' }, testSecret, { subject: '7d9d3e51-0912-45ab-8c6a-c41c9e431171', expiresIn: '5m' });
let socket: Socket | undefined;

after(async () => {
  socket?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health endpoint responds over HTTP without data services', async () => {
  const latencies: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const startedAt = performance.now();
    const response = await fetch(`${apiUrl}/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    latencies.push(performance.now() - startedAt);
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.ceil(value * sorted.length) - 1];
  console.info(`METRIC API_GET_HEALTH_LIVE_P50_MS=${percentile(0.5).toFixed(2)} API_GET_HEALTH_LIVE_P95_MS=${percentile(0.95).toFixed(2)} SAMPLES=${latencies.length}`);
});

test('vendor search rejects invalid coordinates before querying the database', async () => {
  const response = await fetch(`${apiUrl}/api/vendors?latitude=91&longitude=7.6`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid coordinates' });
});

test('authenticated order creation rejects invalid payloads before database access', async () => {
  const response = await fetch(`${apiUrl}/api/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendorId: 'not-a-uuid' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid order');
});

test('authenticated Socket.IO health ping returns an acknowledgement', async () => {
  socket = createClient(apiUrl, { auth: { token: customerToken }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 5000);
    socket?.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket?.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
  });

  const roundTripMs = await new Promise<number>((resolve, reject) => {
    const startedAt = performance.now();
    socket?.timeout(5000).emit('health:ping', (error: Error | null, result?: { timestamp: number }) => {
      if (error) return reject(error);
      if (!result || result.timestamp <= 0) return reject(new Error('Invalid Socket.IO ping acknowledgement'));
      resolve(performance.now() - startedAt);
    });
  });
  console.info(`METRIC SOCKET_IO_PING_RTT_MS=${roundTripMs.toFixed(2)} TRANSPORT=websocket`);
  assert.ok(roundTripMs >= 0);
  socket.close();
  socket = undefined;
});
