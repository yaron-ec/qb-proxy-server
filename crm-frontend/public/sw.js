/**
 * EC CRM Service Worker — Build: __BUILD_HASH__
 * Cache version: ec-crm-v__BUILD_HASH__
 *
 * CACHE INVALIDATION STRATEGY (auto-update, no manual action required):
 *
 * The __BUILD_HASH__ placeholder is replaced at build time by the Vite plugin
 * (swBuildHashPlugin in vite.config.js) with the main JS bundle's content hash.
 * This means the SW file content changes on EVERY code change, which triggers
 * the browser's service-worker update lifecycle:
 *
 *   1. Browser detects /sw.js content changed (byte-for-byte comparison)
 *   2. New SW is installed → skipWaiting() activates it immediately
 *   3. On activate: ALL old caches are deleted, clients are claimed
 *   4. main.jsx detects controllerchange → page reloads with fresh content
 *
 * Cache strategy:
 * - Navigation/HTML: network-only (never serve stale app shell)
 * - Hashed static assets: cache-first (safe — Vite hashes filenames, so a
 *   cached file for a given URL is always the correct version; new builds
 *   produce new URLs that aren't in the cache, so they're fetched fresh)
 * - On activate: delete ALL old caches (clears stale assets from previous builds)
 *
 * This ensures every new deployment automatically invalidates obsolete cached
 * bundles without requiring users to clear browser storage, use incognito
 * mode, or hard-refresh.
 */

const CACHE_VERSION = 'ec-crm-v__BUILD_HASH__';

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

  // Hashed static assets (JS, CSS, images, fonts): cache-first.
  // These are safe to cache because Vite hashes filenames — a new deploy
  // produces new filenames, so a cached old file is never served for a new URL.
  // CRITICAL: never cache an empty body (causes SyntaxError on JS files).
  const isStaticAsset = url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|webp)$/);
  if (isStaticAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        // Not in cache — fetch from network, cache, and return
        try {
          const response = await fetch(request);
          if (response.ok) {
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          // Network failed and not in cache — return a basic error
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
  }
});
