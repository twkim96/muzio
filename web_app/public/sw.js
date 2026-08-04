const CACHE_NAME = 'muzio-shell-v1.4.2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const IS_DEV_SERVER = ['localhost', '127.0.0.1', '::1'].includes(
  self.location.hostname,
);

self.addEventListener('install', (event) => {
  if (IS_DEV_SERVER) {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
    self.skipWaiting();
    return;
  }

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => IS_DEV_SERVER || key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => {
        if (!IS_DEV_SERVER) return undefined;
        return self.clients
          .matchAll({ type: 'window', includeUncontrolled: true })
          .then((clients) =>
            Promise.all(
              clients.map((client) =>
                'navigate' in client ? client.navigate(client.url) : undefined,
              ),
            ),
          );
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (IS_DEV_SERVER) return;

  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    staleWhileRevalidate(request),
  );
});

function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, copy);
        });
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')));
}

function staleWhileRevalidate(request) {
  return caches.match(request).then((cached) => {
    const fetched = fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
          });
        }
        return response;
      })
      .catch(() => undefined);
    return cached || fetched;
  });
}
