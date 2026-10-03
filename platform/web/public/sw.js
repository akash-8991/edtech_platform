/* Service worker: lets the app open without a connection. It caches the app itself (HTML shell and fingerprinted assets) and NOTHING from the
 * API: lessons are stored by the app in encrypted form, and saved screens by the app per signed-in person. Bump VERSION to drop old caches. */
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`, ASSETS = `assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (event) => { if (event.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/health') || url.pathname === '/metrics') return; // API: always the network, never stored here
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); void caches.open(SHELL).then((c) => c.put('/', copy)); return res; }).catch(() => caches.match('/').then((r) => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
    return;
  }
  if (url.pathname.startsWith('/assets/')) { // fingerprinted: the same URL is always the same bytes
    event.respondWith(caches.open(ASSETS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) void c.put(req, res.clone()); return res; }))));
    return;
  }
  event.respondWith(caches.open(SHELL).then((c) => c.match(req).then((hit) => { const net = fetch(req).then((res) => { if (res.ok) void c.put(req, res.clone()); return res; }).catch(() => hit); return hit || net; })));
});
