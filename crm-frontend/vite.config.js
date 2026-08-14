import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
//
// Two build modes from one config:
//   - default (vite / vite build)        → Base44-hosted CRM (unchanged, live)
//   - exit    (vite --mode exit)          → standalone CRM frontend with NO
//                                          @base44/vite-plugin dependency.
//
// The exit mode loads `.env.exit` automatically (Vite mode-based env files).
// In exit mode the Base44 vite plugin is excluded entirely, so the build never
// requires @base44/vite-plugin or Base44 app params. The default mode is
// byte-for-byte equivalent to the previous static config.
export default defineConfig(({ mode }) => {
  const isExitBuild = mode === 'exit';
  return {
    logLevel: 'error', // Suppress warnings, only show errors
    // The @base44/vite-plugin injects the `@` → `/src` alias. In exit mode the
    // plugin is absent, so declare the alias explicitly. (Default mode gets it
    // from the plugin; adding it there too is harmless but omitted to keep the
    // live build byte-for-byte unchanged.)
    resolve: isExitBuild ? { alias: { '@': path.resolve(__dirname, 'src') } } : undefined,
    plugins: [
      ...(isExitBuild ? [] : [
        base44({
          // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
          // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
          legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
          hmrNotifier: true,
          navigationNotifier: true,
          analyticsTracker: true,
          visualEditAgent: true
        }),
      ]),
      react()
    ]
  }
});