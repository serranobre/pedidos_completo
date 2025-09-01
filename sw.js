/* Serra Nobre – Pedidos: Service Worker (v3.1.4) */
const SW_VERSION = 'pedidos-v3.1.6-2025-09-01';
const CACHE_NAME = `sn-pedidos::${SW_VERSION}`;

// Arquivos principais a manter em cache
const CORE_ASSETS = [
  '/',                       
  '/index.html',
  '/relatorios.html',        // ajuste/remova se não existir
  '/manifest.json',
  '/Serra-Nobre_3.png',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-96x96.png',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/sw.js'
];

// Pré-cache dos arquivos principais
async function cacheCoreAssets(cache) {
  await Promise.allSettled(CORE_ASSETS.map(u => cache.add(u)));
}

// INSTALL → cache inicial + ativa imediatamente
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheCoreAssets(cache);
    self.skipWaiting(); // força ativação imediata
  })());
});

// ACTIVATE → remove versões antigas + assume controle das abas
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('sn-pedidos::') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();

    // avisa todas as abas controladas que o SW novo está ativo
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      client.postMessage({ type: 'SW_ACTIVATED', version: SW_VERSION });
    }
  })());
});

// Mensagens vindas das páginas
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// FETCH → estratégias de cache
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Não cacheia rotas de API
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // Navegação (HTML) → network-first
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req) || await cache.match('/index.html');
        return cached || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' }});
      }
    })());
    return;
  }

  // Arquivos estáticos (css/js/png/etc) → stale-while-revalidate
  const isSameOrigin = url.origin === self.location.origin;
  const isStatic = isSameOrigin && /\.(png|jpg|jpeg|svg|webp|ico|css|js|json|woff2?)$/i.test(url.pathname);

  if (isStatic) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const fetchAndUpdate = fetch(req).then(resp => {
        if (resp && resp.status === 200) cache.put(req, resp.clone());
        return resp;
      }).catch(() => null);
      return cached || await fetchAndUpdate || new Response('', { status: 504 });
    })());
    return;
  }

  // Demais → network direto
});
