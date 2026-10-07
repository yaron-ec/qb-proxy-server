import { describe, test, expect, beforeEach, afterEach } from 'vitest';

/**
 * apiConfig.test.jsx — PRODUCTIZATION regression guard.
 *
 * apiConfig.js previously fell back to EC's own live production Railway URL
 * (https://qb-proxy-server-production.up.railway.app) whenever none of
 * VITE_RAILWAY_API_URL / VITE_QB_PROXY_URL / VITE_RAILWAY_CAPTURE_URL were
 * set at build time. Under the productized single-tenant-per-deployment
 * model that is a cross-company data-leakage trap: a misconfigured
 * Company #4 build would silently talk to EC's own live backend instead of
 * failing visibly. Fixed to fall back to null, which makes the ALREADY-
 * EXISTING isApiConfigured() check (consumed by lib/AuthContext.jsx's clean
 * "not configured" error path) actually able to return false.
 *
 * Each test re-imports the module fresh (vi.resetModules + dynamic import)
 * because its exports are computed once from import.meta.env at module
 * load time.
 */
describe('apiConfig', () => {
  const ENV_KEYS = ['VITE_RAILWAY_API_URL', 'VITE_QB_PROXY_URL', 'VITE_RAILWAY_CAPTURE_URL'];

  beforeEach(() => {
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('with no env var set, RAILWAY_API_URL is null and isApiConfigured() is false — never a hardcoded EC production fallback', async () => {
    vi.resetModules();
    const mod = await import('./apiConfig.js');
    expect(mod.RAILWAY_API_URL).toBeNull();
    expect(mod.isApiConfigured()).toBe(false);
    expect(mod.getApiUrl()).toBeNull();
  });

  test('never falls back to EC\'s hardcoded production Railway URL under any circumstance', async () => {
    vi.resetModules();
    const mod = await import('./apiConfig.js');
    expect(mod.RAILWAY_API_URL).not.toBe('https://qb-proxy-server-production.up.railway.app');
  });

  test('VITE_RAILWAY_API_URL, when set, is used verbatim', async () => {
    vi.stubEnv('VITE_RAILWAY_API_URL', 'https://acme-api.up.railway.app');
    vi.resetModules();
    const mod = await import('./apiConfig.js');
    expect(mod.RAILWAY_API_URL).toBe('https://acme-api.up.railway.app');
    expect(mod.isApiConfigured()).toBe(true);
  });

  test('falls back through the compatibility aliases in order when the primary var is unset', async () => {
    vi.stubEnv('VITE_QB_PROXY_URL', 'https://legacy-alias.up.railway.app');
    vi.resetModules();
    const mod = await import('./apiConfig.js');
    expect(mod.RAILWAY_API_URL).toBe('https://legacy-alias.up.railway.app');
  });
});
