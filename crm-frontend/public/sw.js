/**
 * Service Worker — Network-First Strategy
 *
 * Always fetches from network first. Falls back to cache only if offline.
 * On every install, immediately takes control (no waiting for old tabs to close).
 * This ensures published builds are always served fresh from the CDN/server.
 */

const CACHE_NAME = 'ec-crm-v5';

// On install: skip waiting so new SW activates immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// On activate: delete all old caches and claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first. Only cache GET requests for static assets.
// HTML navigation requests (index.html) are NEVER cached — always network.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET requests or cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cache API calls or backend function calls
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/functions/') ||
    url.pathname.startsWith('/entities/')
  ) {
    return;
  }

  // HTML navigation: always go to network (ensures latest index.html)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (JS, CSS, images): network-first, cache as fallback.
  // CRITICAL: never cache or serve an empty JS/CSS body. The browser would
  // throw "SyntaxError: Unexpected end of input" with no stack trace. Empty
  // 200 responses occur transiently during dev rebuilds; skip caching them
  // and fall back to the last good cached copy if one exists.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        const isStaticAsset = url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$/);
        if (response.ok && isStaticAsset) {
          // Inspect the body without consuming the response we return
          const clone = response.clone();
          const text = await clone.text();
          if (text && text.length > 0) {
            const cache = await caches.open(CACHE_NAME);
            // Reconstruct from the read text so the cached copy has a real body
            await cache.put(request, new Response(text, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }));
          } else {
            // Empty body — don't poison the cache. Serve a good cached copy if we have one.
            const cached = await caches.match(request);
            if (cached) return cached;
            // No good cache either. For JS, return a valid no-op module so the
            // browser never throws "SyntaxError: Unexpected end of input" on an
            // empty 200 (which happens transiently during rebuilds). A fresh
            // reload will fetch the real content.
            if (url.pathname.match(/\.(js|jsx|mjs)$/)) {
              return new Response('//', {
                status: 200,
                headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
              });
            }
          }
        }
        return response;
      } catch {
        return caches.match(request);
      }
    })()
  );
});
