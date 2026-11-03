// Lantern's service worker: keeps the app shell, its built files and fonts on
// this device so Lantern opens without a connection. It never touches /api
// (the app keeps its own data in IndexedDB) or Cloudflare Access's /cdn-cgi.

const SHELL = "lantern-shell-v1";
const ASSETS = "lantern-assets-v1";
const FONTS = "lantern-fonts-v1";
const KEEP = [SHELL, ASSETS, FONTS];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add("/"))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return;
    if (req.mode === "navigate") return event.respondWith(page(req));
    if (url.pathname.startsWith("/assets/")) return event.respondWith(cacheFirst(ASSETS, req));
    return;
  }
  if (url.hostname === "fonts.gstatic.com") return event.respondWith(cacheFirst(FONTS, req));
  if (url.hostname === "fonts.googleapis.com") return event.respondWith(staleWhileRevalidate(FONTS, req));
});

// Pages: the network first, so a new deploy (or an Access sign-in redirect)
// always wins; the saved shell only when the network is unreachable.
async function page(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put("/", copy));
    }
    return res;
  } catch {
    const cached = await caches.match("/", { cacheName: SHELL });
    return cached || Response.error();
  }
}

// Built files have content hashes in their names, so a saved copy never goes stale.
async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || fresh;
}
