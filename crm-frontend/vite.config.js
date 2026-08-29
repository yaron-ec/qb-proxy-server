import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
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
      react()
    ]
  };
});