// sw.js — atualização rápida e segura
const CACHE_VERSION = 'v9';                            // << bump na versão
const STATIC_CACHE  = `serranobre-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `serranobre-runtime-${CACHE_VERSION}`;

// Arquivos para pré-cache (mantenha se quiser offline imediato)
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

// ——————————— Instalação
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Não chamamos skipWaiting aqui. Vamos controlar pelo postMessage da página.
});

// ——————————— Ativação
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => /serranobre-(static|runtime)-/.test(k) && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ——————————— Mensagens (para SKIP_WAITING)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ——————————— Estratégias de fetch
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Nunca interceptar sua API
  if (sameOrigin && url.pathname.startsWith('/api/')) return;

  // 1) Navegação/HTML => networkFirst
  const acceptsHTML = req.headers.get('accept')?.includes('text/html');
  if (acceptsHTML) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 2) Estáticos: js/css/imagens => staleWhileRevalidate
  if (sameOrigin && /\.(?:js|css|png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 3) Demais same-origin => cacheFirst (seguro)
  if (sameOrigin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Cross-origin (CDNs, Firebase etc.) => não intercepta
});

// ——————————— Helpers
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request, { ignoreVary: true });
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  const networkPromise = fetch(request)
    .then((resp) => { if (resp && resp.ok) cache.put(request, resp.clone()); return resp; })
    .catch(() => null);
  return cached || networkPromise || fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}