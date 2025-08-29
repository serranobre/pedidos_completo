/* Serra Nobre – Pedidos: Service Worker (v3.1.3) */
const SW_VERSION = 'pedidos-v3.1.3-2025-08-29';
const CACHE_NAME = `sn-pedidos::${SW_VERSION}`;

// Liste somente o que existe no deploy
const CORE_ASSETS = [
  '/',                       // landing
  '/index.html',
  '/relatorios.html',        // incluir se existir
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

/** Cache inicial resiliente */
async function cacheCoreAssets(cache) {
  const results = await Promise.allSettled(CORE_ASSETS.map(u => cache.add(u)));
  // Opcional: debug das falhas em dev
  // results.forEach((r, i) => { if (r.status === 'rejected') console.warn('[SW] Falhou cachear:', CORE_ASSETS[i]); });
}

/** INSTALL: pré-cache e força ativação imediata */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheCoreAssets(cache);
    // Força o SW novo a sair do "waiting" imediatamente
    self.skipWaiting();
  })());
});

/** ACTIVATE: limpa caches antigos, assume controle e notifica clientes */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('sn-pedidos::') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();

    // Opcional: avisa as tabs que um novo SW está ativo
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      client.postMessage({ type: 'SW_ACTIVATED', version: SW_VERSION });
      // Se quiser forçar reload aqui, descomente a linha abaixo:
      // client.navigate(client.url);
    }
  })());
});

/** Mensagens vindas da página */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Estratégias de fetch:
 * - /api/* -> network-only (não cachear dinâmicos)
 * - Navegação (HTML) -> network-first com fallback para cache (/index.html)
 * - Estático same-origin (png/svg/ico/css/js/json/woff2) -> stale-while-revalidate
 * - Outros -> network (sem cache)
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Só tratamos GET
  if (req.method !== 'GET') return;

  // Nunca cacheia chamadas de API do próprio domínio
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return; // network-only
  }

  // Navegação/HTML: network-first
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        // Opcional: cachear a navegação atual
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        // tenta a página solicitada ou cai para o index.html
        const cached = await cache.match(req) || await cache.match('/index.html');
        return cached || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Estático same-origin: stale-while-revalidate
  const isSameOrigin = url.origin === self.location.origin;
  const isStatic = isSameOrigin && /\.(png|jpg|jpeg|svg|webp|ico|css|js|json|txt|woff2?)$/i.test(url.pathname);

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

  // Demais requisições: padrão (network)
});