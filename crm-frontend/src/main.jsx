import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { isExitBuild } from '@/lib/app-params'

// Service worker: register ONLY in the true production standalone (exit) build.
// In development and Base44 Preview, unregister any stale workers so they
// cannot interrupt React startup or serve stale assets.
//
// AUTO-UPDATE LIFECYCLE (no manual action required):
//   1. On every page load, the browser checks if /sw.js changed (byte-for-byte).
//      The SW file includes a build hash (injected by Vite), so it changes on
//      every code change.
//   2. If changed: new SW installs → skipWaiting() → activates immediately.
//   3. On activate: ALL old caches are deleted, clients are claimed.
//   4. controllerchange event fires → page reloads with fresh content.
//   5. CACHE_UPDATED message from SW → page reloads (backup mechanism).
//
// This ensures normal browser users always receive the current production
// frontend automatically — no incognito, DevTools, or hard-refresh required.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;

  // Reload when a new service worker takes control (automatic update)
  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  }

  // Reload when the service worker sends a CACHE_UPDATED message
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CACHE_UPDATED' && hadController) {
      window.location.reload();
    }
  });

  window.addEventListener('load', () => {
    if (isExitBuild) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        // Detect a new service worker being installed
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              // New SW has activated — reload to get fresh content
              if (newWorker.state === 'activated' && hadController) {
                window.location.reload();
              }
            });
          }
        });

        // Force-check for updates on every page load. The browser also checks
        // automatically, but this ensures we catch updates even if the browser's
        // own check was delayed or skipped (e.g., after waking from sleep).
        reg.update().catch(() => {});
      }).catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    } else {
      // Dev / Base44 Preview — remove any stale service workers
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(reg => reg.unregister());
      }).catch(() => {});
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)