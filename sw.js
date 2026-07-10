/* Spikegolf service worker — offline-first, split caches
   ---------------------------------------------------------
   APP_CACHE   — versioned per release. Holds the small app
                 shell (index.html, app.js, styles.css, manifest).
                 On activation older APP_CACHEs are wiped so the
                 user always gets the fresh UI.
   HEAVY_CACHE — versioned only when the big assets themselves
                 change (map.glb, Three.js vendor bundle, hero
                 image, icons, fonts). Survives app-cache bumps
                 so users don't re-download ~90 MB on every
                 release.
*/
const APP_CACHE   = 'spikegolf-app-v15';
const HEAVY_CACHE = 'spikegolf-heavy-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
];

const HEAVY_ASSETS = [
  './map.glb',
  './hero.jpg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/three/three.module.min.js',
  './vendor/three/GLTFLoader.js',
  './vendor/three/BufferGeometryUtils.js',
  './vendor/three/OrbitControls.js',
];

const isHeavyRequest = (url) => HEAVY_ASSETS.some(p => url.pathname.endsWith(p.replace(/^\.\//, '/')));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // App shell is small — grab it up front, always fresh.
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_ASSETS);

    // Heavy assets: only fetch entries that aren't already cached.
    // That way an install triggered by an APP_CACHE bump doesn't
    // re-download map.glb.
    const heavy = await caches.open(HEAVY_CACHE);
    for (const url of HEAVY_ASSETS) {
      try {
        const existing = await heavy.match(url);
        if (!existing) await heavy.add(new Request(url, { cache: 'reload' }));
      } catch (_) { /* offline install is fine */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== APP_CACHE && k !== HEAVY_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts → stale-while-revalidate in HEAVY_CACHE (they rarely change).
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const cache = await caches.open(HEAVY_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // Same-origin: split by asset kind.
  if (url.origin === self.location.origin) {
    const heavy = isHeavyRequest(url);
    const primary = heavy ? HEAVY_CACHE : APP_CACHE;

    e.respondWith((async () => {
      // Check the primary cache first, then the other one (during
      // migrations an asset might live in either), then network.
      const p = await caches.open(primary);
      const cached = await p.match(req);
      if (cached) return cached;

      const otherName = heavy ? APP_CACHE : HEAVY_CACHE;
      const o = await caches.open(otherName);
      const otherCached = await o.match(req);
      if (otherCached) return otherCached;

      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(primary).then(c => c.put(req, copy));
        }
        return res;
      } catch (_) { return cached || otherCached; }
    })());
  }
});
