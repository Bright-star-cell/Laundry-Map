import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

type WorkerRequest = { method: string; url: string };
type WorkerResponse = { ok: boolean; body: string; clone: () => WorkerResponse };
type WorkerEvent = {
  request?: WorkerRequest;
  waitUntil?: (promise: Promise<unknown>) => void;
  respondWith?: (promise: Promise<WorkerResponse | undefined>) => void;
};

async function createWorker(networkFetch: (request: WorkerRequest) => Promise<WorkerResponse>, existingCaches: string[] = []) {
  const workerSource = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, WorkerResponse>();
  const removedCaches: string[] = [];
  let skippedWaiting = false;
  let clientsClaimed = false;
  const cache = {
    async addAll(paths: string[]) {
      paths.forEach((path) => entries.set(path, { ok: true, body: path, clone() { return this; } }));
    },
    async match(request: WorkerRequest | string) {
      const key = typeof request === 'string' ? request : request.url;
      return entries.get(key);
    },
    async put(request: WorkerRequest, response: WorkerResponse) {
      entries.set(request.url, response);
    },
  };
  const cacheStorage = {
    async open() { return cache; },
    async keys() { return existingCaches; },
    async delete(name: string) { removedCaches.push(name); return true; },
    async match(request: WorkerRequest | string) { return cache.match(request); },
  };
  const self = {
    location: { origin: 'https://laundry.test' },
    clients: { claim() { clientsClaimed = true; } },
    addEventListener(name: string, handler: (event: WorkerEvent) => void) { handlers.set(name, handler); },
    skipWaiting() { skippedWaiting = true; },
  };

  runInNewContext(workerSource, { self, caches: cacheStorage, fetch: networkFetch, URL });
  return { handlers, entries, removedCaches, get skippedWaiting() { return skippedWaiting; }, get clientsClaimed() { return clientsClaimed; } };
}

function response(body: string): WorkerResponse {
  return { ok: true, body, clone() { return this; } };
}

test('install caches the app shell and activates the worker immediately', async () => {
  const worker = await createWorker(async () => response('network'));
  let installTask: Promise<unknown> | undefined;
  worker.handlers.get('install')?.({ waitUntil(task) { installTask = task; } });
  await installTask;

  assert.equal([...worker.entries.keys()].sort().join(','), '/,/icon.svg,/manifest.json');
  assert.equal(worker.skippedWaiting, true);
});

test('activation removes stale caches and claims existing clients', async () => {
  const worker = await createWorker(async () => response('network'), ['laundry-map-shell-old', 'laundry-map-shell-v1']);
  let activationTask: Promise<unknown> | undefined;
  worker.handlers.get('activate')?.({ waitUntil(task) { activationTask = task; } });
  await activationTask;

  assert.deepEqual(worker.removedCaches, ['laundry-map-shell-old']);
  assert.equal(worker.clientsClaimed, true);
});

test('API requests bypass the cache and offline app requests use the cached shell', async () => {
  let networkRequests = 0;
  const worker = await createWorker(async () => {
    networkRequests += 1;
    throw new Error('offline');
  });
  worker.entries.set('/', response('cached app shell'));
  const fetchHandler = worker.handlers.get('fetch');
  let apiHandled = false;
  fetchHandler?.({ request: { method: 'GET', url: 'https://laundry.test/api/orders' }, respondWith() { apiHandled = true; } });
  assert.equal(apiHandled, false);

  let appResponse: Promise<WorkerResponse | undefined> | undefined;
  fetchHandler?.({ request: { method: 'GET', url: 'https://laundry.test/orders' }, respondWith(result) { appResponse = result; } });
  assert.equal((await appResponse)?.body, 'cached app shell');
  assert.equal(networkRequests, 1);
});
