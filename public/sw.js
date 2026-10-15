// Offline shell. Each build has its own cache: scripts/postexport.mjs stamps CACHE and lists the build's files in
// BUILD, and installing fetches all of them, so a release works offline as soon as it takes over. The engine and
// recognition files this device used with the last release are fetched again with the new one (asked for anew:
// unchanged ones come back as "not modified"). A release takes over once no page of the last one is open, so a page
// never gets the new release's workers under its old code.
const CACHE = 'tessel-dev';
// The models (~17 MB) are the same from release to release: kept apart, not downloaded again with each one.
const MODELS = 'tessel-models';
// Paths resolve against the worker's own URL, so the app works under any base path.
const ROOT = new URL('./', self.location.href).href;
const BUILD = [];
const SHELL = [ROOT, 'manifest.webmanifest', 'engine/pdfium-worker.js', 'engine/pdfium.wasm', 'engine/search-worker.js', ...BUILD];
const ENGINE = /\/(engine|ocr)\//;
// Only Tessel's caches: the origin may be shared with other sites (user.github.io).
const ours = (key) => key.startsWith('tessel-');
// A start doesn't wait longer than this for a slow connection: the kept page comes up instead.
const NAVIGATE_MS = 4000;

const fresh = (url) => new Request(new URL(url, ROOT), { cache: 'no-cache' });

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL.map(fresh));
      const used = new Set();
      for (const key of (await caches.keys()).filter((k) => ours(k) && k !== CACHE && k !== MODELS)) {
        for (const req of await (await caches.open(key)).keys()) if (ENGINE.test(new URL(req.url).pathname)) used.add(req.url);
      }
      await Promise.all([...used].map((url) => cache.add(fresh(url)).catch(() => {})));
      // Nothing of the last release is open: this one takes over now.
      if (!(await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ours(k) && k !== CACHE && k !== MODELS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Pages from the network when it answers in time (a newer release's page isn't kept: its files would be missing
 * here), else this release's page.
 */
const navigate = (req) =>
  new Promise((resolve) => {
    let done = false;
    const kept = () => caches.match(ROOT, { cacheName: CACHE });
    const timer = setTimeout(() => {
      done = true;
      kept().then((res) => resolve(res ?? fetch(req)));
    }, NAVIGATE_MS);
    fetch(req).then(
      (res) => {
        if (done) return;
        clearTimeout(timer);
        resolve(res);
      },
      () => {
        if (done) return;
        clearTimeout(timer);
        kept().then((res) => resolve(res ?? Response.error()));
      },
    );
  });

/** What this release keeps, else from the network (and kept). */
const kept = (req, store) =>
  caches.open(store).then(async (c) => {
    const hit = await c.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(navigate(req));
  e.respondWith(kept(req, url.pathname.includes('/models/') ? MODELS : CACHE));
});
