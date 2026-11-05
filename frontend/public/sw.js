const CACHE_NAME = 'laundry-map-shell-v2';
const APP_SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('laundry-map-shell-') && key !== CACHE_NAME)
    .map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match('/'))));
    return;
  }
  if (!APP_SHELL.includes(url.pathname) || url.pathname === '/') {
    if (!url.pathname.startsWith('/_next/static/')) return;
  }
  const response = fetch(event.request);
  event.waitUntil(response.then((result) => {
    if (!result.ok) return;
    return caches.open(CACHE_NAME).then((cache) => cache.put(event.request, result.clone()));
  }, () => undefined));
  event.respondWith(response.catch(async () => await caches.match(event.request)));
});