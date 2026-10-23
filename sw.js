// Offline asset cache: download the heavy vendor/models blobs once per
// browser, then serve them from the device forever.
//
// WHY this file exists: Chromium refuses to keep the 83 MB GLiNER onnx
// weights in its HTTP cache (net::ERR_CACHE_WRITE_FAILURE), so every visit
// re-downloaded them. The Cache Storage API used here has no such limit.
//
// WHY user documents are safe: this worker only handles fetch events for
// same-origin GET requests under vendor/ and models/ (see
// js/asset-cache.js). User files are read via File/picker APIs and are never
// fetched, so they never pass through here and are never seen or stored.
//
// Workers created before this SW controls the page (the very first visit)
// simply download normally; module/dedicated GLiNER and Tesseract workers
// inherit their client's controller, so once this SW is active their fetches
// go through it too (plus skipWaiting/clients.claim below catch up the first
// visit's later fetches).
import { CACHE_NAME, shouldCache } from "./js/asset-cache.js";

// Revalidated at most once per SW lifetime per URL: the user is never blocked
// on an update check, and repeat navigations stay instant.
const revalidated = new Set();

self.addEventListener("install", (event) => {
  // WHY skipWaiting: start caching the first visit's later fetches instead of
  // waiting for all tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // WHY versioned name: bump CACHE_NAME for a breaking change to force a
      // refresh; stale generations are dropped here.
      for (const name of await caches.keys()) {
        if (name !== CACHE_NAME && name.startsWith("pii-assets-")) await caches.delete(name);
      }
      // WHY claim: take control of open pages so their worker fetches are
      // cached without requiring a reload.
      await self.clients.claim();
    })(),
  );
});

// WHY conditional revalidation in the background: serve the cached bytes
// immediately (instant second visit), then ask the server for changes with
// If-None-Match / If-Modified-Since. A 200 body replaces the entry; 304 or a
// network error keeps the cached copy. Never awaited by the page.
function revalidateInBackground(event, request, cached) {
  if (revalidated.has(request.url)) return;
  const etag = cached.headers.get("etag");
  const lastModified = cached.headers.get("last-modified");
  if (!etag && !lastModified) return;
  revalidated.add(request.url);
  event.waitUntil(
    (async () => {
      try {
        const headers = {};
        if (etag) headers["if-none-match"] = etag;
        if (lastModified) headers["if-modified-since"] = lastModified;
        const fresh = await fetch(new Request(request.url, { headers }));
        if (fresh && fresh.status === 200 && fresh.type !== "opaque") {
          try {
            await (await caches.open(CACHE_NAME)).put(request, fresh.clone());
          } catch {
            // Quota: keep serving the old copy.
          }
        }
        if (fresh && fresh.body && fresh.body.cancel) {
          try {
            await fresh.body.cancel();
          } catch {
            /* ignore */
          }
        }
      } catch {
        // Offline: the cached copy stays.
      }
    })(),
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!shouldCache(request.url, request.method, request.headers, self.registration.scope)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        revalidateInBackground(event, request, cached);
        return cached;
      }
      const response = await fetch(request);
      // WHY only plain 200s: never store a 404 page or a 206 slice as the
      // asset (Range/HEAD probes bypass the cache via shouldCache anyway).
      if (response && response.status === 200 && response.type !== "opaque") {
        try {
          // WHY clone: store the stream while it flows to the page, so the
          // first download is still a single download.
          await cache.put(request, response.clone());
        } catch {
          // Quota or eviction: return the network bytes anyway.
        }
      }
      return response;
    })(),
  );
});
