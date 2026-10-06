// AURA AI service worker: makes the app installable and lets the app shell open offline.
// Network-first, so new deployments show up straight away; the cache is only a fallback.
const CACHE = 'aura-v3';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/firebase-config.js', '/manifest.webmanifest', '/icon-192.png', '/privacy.html', '/terms.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' && (await caches.match('/'))) || Response.error())
  );
});
