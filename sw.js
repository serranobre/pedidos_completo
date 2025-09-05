/* Serra Nobre – Pedidos: Service Worker (v3.1.8) */
const APP_VERSION = '3.2.1';
const SW_VERSION  = `pedidos-v${APP_VERSION}-2025-09-03`;
const CACHE_NAME  = `sn-pedidos::${SW_VERSION}`;

// Detecta base path (raiz ou subpasta) a partir do escopo do SW
const SCOPE_URL = new URL(self.registration.scope);
const BASE_PATH = SCOPE_URL.pathname.endsWith('/') ? SCOPE_URL.pathname : SCOPE_URL.pathname + '/';

// Constrói URL absoluta dentro do mesmo host/escopo
const abs = (path) => new URL(path, SCOPE_URL).toString();

// Lista de ativos centrais (usar caminhos relativos ao projeto)
const CORE_ASSETS_REL = [
  'index.html',
  'relatorios.html',          // ajuste/remova se não existir no deploy
  'manifest.json',
  'Serra-Nobre_3.png',
  'favicon.ico',
  'favicon.svg',
  'favicon-96x96.png',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'sw.js'
];

// Converte para URLs absolutas respeitando subpasta
const CORE_ASSETS = [
  BASE_PATH, // raiz da app
  ...CORE_ASSETS_REL.map(p => abs(p))
];

// Pré-cache
async function cacheCoreAssets(cache) {
  const reqs = CORE_ASSETS.map((u) => new Request(u, { cache: 'reload' }));
  const results = await Promise.allSettled(reqs.map((r) => cache.add(r)));
  // Opcional: log silencioso de falhas individuais (não quebra install)
  // results.forEach((res, i) => { if (res.status === 'rejected') console.debug('skip precache:', CORE_ASSETS[i]); });
}

// INSTALL → precache + ativação imediata
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheCoreAssets(cache);
    await self.skipWaiting();
  })());
});

// ACTIVATE → limpa caches antigos + assume abas
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('sn-pedidos::') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();

    // avisa janelas que novo SW está ativo
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      client.postMessage({ type: 'SW_ACTIVATED', version: SW_VERSION });
    }
  })());
});

// Mensagens vindas das páginas
self.addEventListener('message', (event) => {
  const data = event.data;
  const type = (typeof data === 'string') ? data : (data && data.type);
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Util: timeout de rede (promessa)
function fetchWithTimeout(req, ms = 8000, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), ms);
  return fetch(req, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

// Decide se é HTML de navegação
function isHTMLRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

// Não cachear APIs (locais) e domínios dinâmicos (ex.: Firebase)
function isBypassCache(url) {
  const u = new URL(url);
  if (u.origin === self.location.origin && u.pathname.startsWith(BASE_PATH + 'api/')) return true;
  // Firestore / GCP / auth / storage etc.
  const bypassHosts = [
    'firestore.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'storage.googleapis.com',
    'www.googleapis.com'
  ];
  return bypassHosts.includes(u.host);
}

// Estáticos same-origin
function isStaticSameOrigin(url) {
  const u = new URL(url);
  if (u.origin !== self.location.origin) return false;
  return /\.(png|jpg|jpeg|svg|webp|ico|css|js|json|woff2?)$/i.test(u.pathname);
}

// Fallback offline simples
function offlineHTML() {
  return new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><h1>Offline</h1><p>Sem conexão e sem cache disponível.</p>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Bypass APIs/dinâmicos
  if (isBypassCache(req.url)) return;

  // Navegação (HTML) → network-first com fallback
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        const net = await fetchWithTimeout(req, 9000, { cache: 'no-store' });
        // atualiza cache de navegação
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        // tenta match do próprio request; se não, cai para index.html do BASE_PATH
        const cached = await cache.match(req, { ignoreSearch: true }) ||
                       await cache.match(abs('index.html'));
        return cached || offlineHTML();
      }
    })());
    return;
  }

  // Estáticos same-origin → stale-while-revalidate (ignora querystrings)
  if (isStaticSameOrigin(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      const fetchAndUpdate = fetch(req).then(resp => {
        if (resp && resp.status === 200) cache.put(req, resp.clone());
        return resp;
      }).catch(() => null);
      return cached || await fetchAndUpdate || new Response('', { status: 504 });
    })());
    return;
  }

  // Demais GET same-origin → tentativa de rede com pequeno fallback de cache
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || new Response('', { status: 504 });
      }
    })());
  }
});