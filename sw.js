// sw.js
const CACHE_VERSION = 'v8';
const CACHE_NAME = `serranobre-static-${CACHE_VERSION}`;

// Disponível offline (caminhos relativos)
const PRECACHE_URLS = [
  './',
  './index.html',
  './relatorios.html',
  './manifest.json',
  './favicon.ico',
  './favicon.svg',
  './favicon-96x96.png',
  './apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './Serra-Nobre_3.png',
  './site.webmanifest', // se existir
];

// Install: abre o cache e adiciona os estáticos
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

// Activate: limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('serranobre-static-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Fetch strategies
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // NUNCA interceptar a API (mesmo se algum GET passar por aqui)
  if (sameOrigin && url.pathname.startsWith('/api/')) return;

  const isImage = /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname);

  if (sameOrigin && isImage) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (sameOrigin) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // Pedidos cross-origin (CDNs, Firebase etc.): não interceptar
});

// Helpers
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
  const networkPromise = fetch(request).then((resp) => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => undefined);
  return cached || networkPromise || fetch(request);
}
