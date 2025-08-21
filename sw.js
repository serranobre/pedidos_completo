// sw.js
const CACHE_VERSION = 'v7';
const CACHE_NAME = `serranobre-static-${CACHE_VERSION}`;

// Liste aqui tudo que precisa ficar disponível offline.
// Caminhos RELATIVOS para GitHub Pages.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './favicon.svg',
  './favicon-96x96.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './Serra-Nobre_3.png',      // logo base (a app ainda usa um ?v=YYYYMMDD)
  './site.webmanifest',       // se você mantém, tudo bem pré‑cachear
  // Bibliotecas externas críticas podem ser deixadas de fora para evitar CORS/cache issues.
];

// Abre o cache e adiciona os estáticos
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
});

// Limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k.startsWith('serranobre-static-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Estratégias de resposta:
// 1) Para nossos estáticos do mesmo domínio → cache-first.
// 2) Para imagens/ícones (png/jpg/svg/webp) → stale-while-revalidate.
// 3) Fallback padrão → network-first com cache (para outros GET do mesmo domínio).
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Só tratamos GET
  if (req.method !== 'GET') return;

  // Somente requests do mesmo origem (não intercepta Firebase/apIs externas)
  const sameOrigin = url.origin === self.location.origin;

  // Heurística de imagens
  const isImage = /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname);

  if (sameOrigin && isImage) {
    // stale-while-revalidate para imagens
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (sameOrigin) {
    // cache-first para nossos estáticos
    event.respondWith(cacheFirst(req));
    return;
  }

  // Para origens diferentes (ex: Firebase), não interferimos.
});

// --- Helpers de estratégia ---
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
  if (cached) return cached;
  const resp = await fetch(request);
  // Só cacheia respostas válidas
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
  const networkPromise = fetch(request).then(resp => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => undefined);
  return cached || networkPromise || fetch(request);
}
