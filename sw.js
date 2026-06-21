const CACHE = 'sushi-split-v12';
const ASSETS = [
  './index.html',
  './manifest.json',
  './sushiicon.svg',
  './pin-fish-empty.svg',
  './pin-fish-full.svg'
];
// Without these being cached *somehow*, opening the installed app with zero
// connectivity would crash before rendering anything: the page's own script
// calls window.supabase.createClient(...) as its very first statement, which
// throws if that library never loaded. The QR library isn't load-bearing the
// same way (it's only touched when the Share popup opens), but caching it
// too means sharing a room still works even if you're offline at the table.
const CDN_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js'
];
const RUNTIME_CACHE_HOSTS = ['cdn.jsdelivr.net'];

// Core assets are cached atomically (install fails if any of THESE fail --
// correct, they're essential). Each CDN script is attempted separately and
// independently: a CDN hiccup at install time shouldn't be able to fail the
// whole install, and one script failing shouldn't block another. Anything
// that fails here gets picked up opportunistically by the fetch handler's
// GET-caching on the next successful online load instead.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(ASSETS);
      await Promise.all(CDN_SCRIPTS.map(url => c.add(url).catch(() => {})));
    })
  );
  self.skipWaiting();
});

// Remove old cache versions on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for anything already cached. For GET requests to allow-listed
// CDN hosts (not Supabase -- never cache its POST-based API calls, which
// would risk serving a stale/wrong response for a different room or RPC),
// opportunistically cache a successful response so it survives going
// offline later, even though it wasn't part of the atomic install step.
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      const url = new URL(e.request.url);
      const cacheable = e.request.method === 'GET' && RUNTIME_CACHE_HOSTS.includes(url.hostname);
      return fetch(e.request).then(response => {
        if (cacheable && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});