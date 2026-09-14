import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
//
// Standalone CRM frontend — Zero Base44.
// The build uses `vite build --mode exit` (loads .env.exit automatically).
// No @base44/vite-plugin, no @base44/sdk, no Base44 stubs.
export default defineConfig({
  logLevel: 'error',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    }
  },
  plugins: [
    react(),
    // SW build-hash injection — replaces __BUILD_HASH__ in dist/sw.js with
    // the main JS bundle's content hash so the SW file content changes on
    // every deployment. This triggers the browser's service-worker update
    // lifecycle (install → skipWaiting → activate → clear old caches →
    // reload) automatically — no manual incognito, DevTools, or hard-refresh
    // required.
    swBuildHashPlugin()
  ]
});

/**
 * Vite plugin: injects a build-specific hash into the service worker file.
 *
 * After the bundle is written to dist/, reads dist/sw.js, replaces the
 * __BUILD_HASH__ placeholder with a hash derived from the main JS chunk's
 * filename, and writes it back. This ensures the SW file content changes
 * with every code change, so the browser detects a SW update and activates
 * the new SW (which clears all old caches and reloads the page).
 *
 * The hash is extracted from the main JS chunk filename (e.g. index-BxlF2qEn.js
 * → BxlF2qEn). This is Vite's content hash of the bundle, so it only changes
 * when the actual code changes — not on every timestamp.
 */
function swBuildHashPlugin() {
  return {
    name: 'sw-build-hash-injection',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      const swPath = path.join(distDir, 'sw.js');

      if (!fs.existsSync(swPath)) {
        console.warn('[sw-hash] dist/sw.js not found — skipping hash injection');
        return;
      }

      // Extract the content hash from the main JS chunk filename.
      let buildHash = '';
      const assetsDir = path.join(distDir, 'assets');
      if (fs.existsSync(assetsDir)) {
        const files = fs.readdirSync(assetsDir);
        // Vite names the entry chunk index-<hash>.js
        const mainJs = files.find(f => /^index-.+\.js$/.test(f));
        if (mainJs) {
          const match = mainJs.match(/^index-(.+)\.js$/);
          if (match) buildHash = match[1];
        }
      }
      // Fallback: use a timestamp so the SW always changes per build
      if (!buildHash) buildHash = Date.now().toString(36);

      let swContent = fs.readFileSync(swPath, 'utf8');
      swContent = swContent.replace(/__BUILD_HASH__/g, buildHash);
      fs.writeFileSync(swPath, swContent, 'utf8');

      console.log(`[sw-hash] Injected build hash into sw.js: ${buildHash}`);
    }
  };
}
