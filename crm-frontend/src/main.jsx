import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { isExitBuild } from '@/lib/app-params'

// Service worker: register ONLY in the true production standalone (exit) build.
// In development and Base44 Preview, unregister any stale workers so they
// cannot interrupt React startup or serve stale assets.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (isExitBuild) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                window.location.reload();
              }
            });
          }
        });
        reg.update();
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