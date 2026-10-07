// Minimal app-shell service worker. Network-first for the app page AND its RSC
// data payloads (what router.refresh() / pull-to-refresh fetch) so scores are
// never served stale. Cache-first ONLY for truly-immutable static assets. The
// cached copy of "/" is an offline fallback — never served while online.
const CACHE = "spike-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

// Assets safe to serve straight from cache: hashed build output + static icons.
// "/" is deliberately absent — it renders live data, and router.refresh()
// re-fetches it as an RSC payload, so it must always hit the network first.
const STATIC_ASSETS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable static assets: cache-first (hashed bundles never change per URL).
  if (url.pathname.startsWith("/_next/static") || STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })),
    );
    return;
  }

  // Everything else — the app page as an HTML navigation AND the RSC payloads
  // fetched by router.refresh()/pull-to-refresh — is network-first, so a refresh
  // always shows the latest scores. Only fall back to the cached shell when the
  // network is genuinely unavailable. We refresh that shell from real
  // navigations only (never from an RSC payload, which is the wrong shape for it).
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (request.mode === "navigate") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match("/"))),
  );
});
