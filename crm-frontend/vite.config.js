import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
//
// Two build modes from one config:
//   - default (vite / vite build)        → Base44-hosted CRM (unchanged, live)
//   - exit    (vite build --mode exit)   → standalone CRM frontend with NO
//                                         @base44/vite-plugin dependency.
//
// The exit mode loads `.env.exit` automatically (Vite mode-based env files).
// In exit mode the Base44 vite plugin is excluded entirely (dynamic import
// guarded by !isExitBuild), so the build never requires @base44/vite-plugin
// or Base44 app params. The default mode is functionally equivalent to the
// previous static config.
export default defineConfig(async ({ mode }) => {
  const isExitBuild = mode === 'exit';

  let base44Plugins = [];
  if (!isExitBuild) {
    // Dynamic import so exit mode never loads @base44/vite-plugin.
    // In default mode the package is installed in the workspace.
    const base44Module = await import("@base44/vite-plugin");
    const base44 = base44Module.default;
    base44Plugins = [
      base44({
        legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
        hmrNotifier: true,
        navigationNotifier: true,
        analyticsTracker: true,
        visualEditAgent: true
      })
    ];
  }

  return {
    logLevel: 'error',
    // The @base44/vite-plugin injects the `@` → `/src` alias. In exit mode the
    // plugin is absent, so declare the alias explicitly. (Default mode gets it
    // from the plugin; adding it there too is harmless but omitted to keep the
    // live build unchanged.)
    resolve: isExitBuild ? {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        // Stub @base44/sdk so ZERO Base44 SDK code reaches the standalone bundle.
        // AuthContext.jsx's platform-required import resolves to this no-op
        // instead of pulling in the real @base44/sdk package.
        '@base44/sdk': path.resolve(__dirname, 'src/api/base44-sdk-stub.js'),
      }
    } : undefined,
    plugins: [
      ...base44Plugins,
      react(),
      // SW build-hash injection — only for exit (production standalone) builds.
      // Replaces __BUILD_HASH__ in dist/sw.js with the main JS bundle's content
      // hash so the SW file content changes on every deployment. This triggers
      // the browser's service-worker update lifecycle (install → skipWaiting →
      // activate → clear old caches → reload) automatically — no manual
      // incognito, DevTools, or hard-refresh required.
      ...(isExitBuild ? [swBuildHashPlugin()] : []),
    ]
  }
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