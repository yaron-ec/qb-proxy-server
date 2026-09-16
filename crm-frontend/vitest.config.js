import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Separate from vite.config.js (the production build config) — this only
// configures the component-level regression test runner (`npm run
// test:components`) and never touches `npm run build:exit`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    }
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setupTests.js'],
    include: ['src/**/*.test.jsx'],
  }
});
