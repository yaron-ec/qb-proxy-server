/**
 * EC CRM Service Worker — Build: 2026-08-30-capture-fix
 * Cache version: ec-crm-v6-capture-fix
 *
 * Cache invalidation strategy:
 * - Navigation/HTML: network-only (never serve stale app shell)
 * - Hashed static assets: network-first, cache fallback (safe — hashes are immutable)
 * - On update: skipWaiting() + clients.claim() for immediate takeover
 * - On activate: delete ALL old caches, notify clients to reload
 *
 * This ensures every new deployment automatically invalidates obsolete
 * cached bundles without requiring users to clear browser storage.
 */

const CACHE_VERSION = 'ec-crm-v6-capture-fix';

// On install: skip waiting so new SW activates immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// On activate: delete ALL old caches, claim all clients, notify them to reload
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll())
      .then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'CACHE_UPDATED' });
        });
      })
  );
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests from same origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never intercept API/backend calls
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/functions/') ||
    url.pathname.startsWith('/entities/')
  ) {
    return;
  }

  // Navigation/HTML: network-only — never serve stale app shell.
  // If offline, return a simple offline page (not a cached old app).
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request).catch(() => new Response(
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>EC CRM — Offline</title><style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155}div{text-align:center;padding:2rem}h2{font-size:1.5rem;margin-bottom:0.5rem}p{color:#64748b}button{margin-top:1.5rem;padding:0.75rem 1.5rem;background:#f59e0b;color:white;border:none;border-radius:0.5rem;font-weight:600;cursor:pointer}</style></head><body><div><h2>You are offline</h2><p>Please check your internet connection and try again.</p><button onclick="window.location.reload()">Retry</button></div></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      ))
    );
    return;
  }

  // Hashed static assets (JS, CSS, images, fonts): network-first, cache fallback.
  // These are safe to cache because Vite hashes filenames — a new deploy
  // produces new filenames, so a cached old file is never served for a new URL.
  // CRITICAL: never cache an empty body (causes SyntaxError on JS files).
  const isStaticAsset = url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|webp)$/);
  if (isStaticAsset) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const clone = response.clone();
            const text = await clone.text();
            if (text && text.length > 0) {
              const cache = await caches.open(CACHE_VERSION);
              await cache.put(request, new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }));
            }
          }
          return response;
        } catch {
          return caches.match(request);
        }
      })()
    );
  }
});
