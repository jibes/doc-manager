// Offline shell: navigations and the engine network-first, the recognition models kept, everything else
// stale-while-revalidate.
// Each build names its own cache (scripts/postexport.mjs stamps CACHE): a release never runs with the last one's
// engine files, and the last one's cache goes once the new worker takes over.
const CACHE = 'tessel-dev';
// The models (~17 MB) are the same from release to release: kept apart, not downloaded again with each one.
const MODELS = 'tessel-models';
// Paths resolve against the worker's own URL, so the app works under any base path.
const ROOT = new URL('./', self.location.href).href;
const SHELL = [ROOT, 'engine/pdfium-worker.js', 'engine/pdfium.wasm', 'manifest.webmanifest'];
// Named the same in every release (not by their content): fetched fresh whenever there is a connection.
const FRESH = /\/(engine|ocr)\//;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MODELS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** From the network (kept for offline use when it answered well), else what was kept. */
const networkFirst = (req, key) =>
  fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    })
    .catch(() => caches.match(key));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, ROOT));
  if (FRESH.test(url.pathname)) return e.respondWith(networkFirst(req, req));
  const store = url.pathname.includes('/models/') ? MODELS : CACHE;
  e.respondWith(
    caches.open(store).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? net;
    }),
  );
});
