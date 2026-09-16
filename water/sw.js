// sw.js — Aqua POS offline app-shell cache
//
// Caches the page itself (plus its manifest/icons) so the app OPENS with no
// internet connection at all, not just keeps working once it's already open.
// Everything the app actually runs on (inventory, sales, receipts, reports)
// already lives in localStorage — this service worker just makes sure the
// shell that renders it doesn't have to come from the network every time.
//
// Bump CACHE_NAME whenever index.html changes materially, so returning devices
// pick up the fresh copy instead of a stale cached one.
const CACHE_NAME = 'aquapos-shell-v16';

// How long to wait for the network on a navigation before falling back to the
// cached copy. Long enough to win on a normal connection, short enough that a
// dead Wi-Fi hotspot doesn't leave the cashier staring at a blank screen.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3500;

// Paths are relative to the service worker's own location, not the site root.
// The previous version used absolute '/index.html' style paths, which silently
// broke on any deployment that isn't at the domain root (a Pages preview URL,
// a project subfolder, a custom path) — the cache would fill with 404s or miss
// entirely, and the app wouldn't open offline.
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// The old install used cache.addAll(), which is ATOMIC: if any single asset
// 404s — a moved icon, a renamed manifest — the entire install rejects and
// NOTHING gets cached, so the app never works offline and gives no clue why.
// Caching each asset independently means one missing icon can't take down
// offline mode for the whole app.
async function cacheShell(cache) {
  const results = await Promise.all(
    SHELL_ASSETS.map(async (path) => {
      try {
        // cache: 'reload' bypasses the HTTP cache so an install always fetches
        // the current file rather than re-caching a stale one.
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (!res || !res.ok) return { path, ok: false };
        await cache.put(path, res);
        return { path, ok: true };
      } catch (e) {
        return { path, ok: false };
      }
    })
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.path);
  if (failed.length) {
    console.warn('[Aqua POS] These shell assets could not be cached:', failed);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cacheShell)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Only the app shell (the page itself + its manifest/icons) is intercepted here,
// using a stale-while-revalidate strategy: serve the cached copy instantly (so
// it opens even offline), and quietly refresh the cache in the background
// whenever there IS a connection, so the next offline open has the latest copy.
//
// Everything else — every /api/* call (M-Pesa, Paystack, barcode lookups,
// cross-device sync) and any POST/PUT request — is left completely untouched
// and goes straight to the network. Those already fail gracefully on their own
// (see pullState()/pushNow() in index.html, which catch network errors and
// just show an "offline" sync badge) when there's no connection.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin requests
  if (url.pathname.includes('/api/')) return;        // never cache API calls

  // A navigation is anything that opens the app (typing the URL, tapping the
  // home-screen icon, a bookmarked ?staff= link). Those must be served from
  // cache when offline, whatever query string they carry.
  const isNavigation = req.mode === 'navigate';
  const isShellAsset = SHELL_ASSETS.some((p) => {
    const tail = p.replace(/^\.\//, '');
    return tail && url.pathname.endsWith(tail);
  });
  if (!isNavigation && !isShellAsset) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Helper: find the cached page for a navigation, ignoring the query string —
      // otherwise opening ?staff=abc offline would miss the cached page entirely
      // and show the browser's offline error page.
      const cachedPage = async () =>
        (await cache.match('./index.html')) ||
        (await cache.match('./')) ||
        (await cache.match(req, { ignoreSearch: true }));

      if (isNavigation) {
        // NETWORK-FIRST for the page itself.
        //
        // This used to be stale-while-revalidate (serve cache instantly, refresh
        // in the background). That made every redeploy invisible: the shop would
        // update the site and still be served the OLD app, because the fresh copy
        // only landed in the cache AFTER the page had already rendered from the
        // stale one. Two separate things made it worse — the background fetch
        // could itself be answered from the browser's own HTTP cache (so the new
        // file was sometimes never fetched at all), and an installed PWA rarely
        // gets reloaded twice in a row, which is what SWR needs to catch up.
        //
        // Now the network wins whenever it answers in time, with 'reload' to
        // bypass the HTTP cache so we're guaranteed the real current file. The
        // cache is still updated on every success and is still the fallback the
        // moment the network is slow or gone — so offline opening is unaffected.
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), NAVIGATION_NETWORK_TIMEOUT_MS);
          const res = await fetch(new Request(req.url, {
            cache: 'reload',
            signal: controller.signal,
            credentials: 'same-origin',
          }));
          clearTimeout(timer);
          if (res && res.ok) {
            cache.put('./index.html', res.clone()).catch(() => { /* quota — not fatal */ });
            return res;
          }
          // Server answered but with an error (502/404/etc) — a cached working
          // copy beats showing the shop an error page.
          return (await cachedPage()) || res;
        } catch (e) {
          // Offline, or slower than the timeout.
          const fallback = await cachedPage();
          if (fallback) return fallback;
          throw e; // nothing cached yet — let the browser show its offline page
        }
      }

      // CACHE-FIRST for the static shell assets (manifest, icons). These are
      // small, rarely change, and are exactly what should load instantly; they're
      // refreshed in the background on every hit.
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            cache.put(req, res.clone()).catch(() => { /* quota — not fatal */ });
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })()
  );
});
