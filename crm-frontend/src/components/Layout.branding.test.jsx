/**
 * Layout.branding.test.jsx — PRODUCTIZATION PHASE 2, Section 5: company
 * identity (name, location, logo, favicon) must load safely from
 * company_settings with a robust fallback, never a broken image. A prior
 * DB-driven logo attempt broke production because a bad/missing URL
 * rendered with no fallback (see CLAUDE.md) — this proves the new
 * preload-then-swap model never does that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import Layout from './Layout';

const get = vi.fn();
vi.mock('@/api/railway/companySettings', () => ({
  get: (...a) => get(...a),
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin', email: 'admin@acme.example', full_name: 'Jordan Admin' }, logout: vi.fn() }),
}));

// Deterministic Image preload: capture the instance so the test controls
// exactly when onload/onerror fires, instead of relying on jsdom's
// non-functional real image loading.
let imageInstances = [];
class FakeImage {
  constructor() { imageInstances.push(this); }
  set src(v) { this._src = v; }
  get src() { return this._src; }
}

beforeEach(() => {
  imageInstances = [];
  global.Image = FakeImage;
  get.mockReset();
  // Layout renders full (desktop) width via useIsMobile(), which needs
  // window.matchMedia — not polyfilled by jsdom by default.
  window.matchMedia = window.matchMedia || (() => ({
    matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {},
  }));
});
afterEach(() => {
  delete global.Image;
});

function renderLayout() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Layout />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('Layout — company branding load/fallback', () => {
  it('renders the static default logo immediately, before any fetch resolves', () => {
    get.mockReturnValue(new Promise(() => {})); // never resolves
    renderLayout();
    const img = document.querySelector('img[alt]');
    expect(img.getAttribute('src')).toBe('/logo-dark.jpg');
  });

  it('a configured company_logo_url that loads successfully replaces the default logo', async () => {
    get.mockResolvedValue({ settings: { company_name: 'Acme Remodeling', company_logo_url: 'https://cdn.acme.example/logo.png' } });
    renderLayout();
    await waitFor(() => expect(imageInstances.length).toBeGreaterThan(0));
    imageInstances[0].onload(); // simulate successful preload
    await waitFor(() => {
      const img = document.querySelector('img[alt]');
      expect(img.getAttribute('src')).toBe('https://cdn.acme.example/logo.png');
    });
  });

  it('a configured company_logo_url that FAILS to load never replaces the default — no broken image', async () => {
    get.mockResolvedValue({ settings: { company_name: 'Acme Remodeling', company_logo_url: 'https://cdn.acme.example/missing.png' } });
    renderLayout();
    await waitFor(() => expect(imageInstances.length).toBeGreaterThan(0));
    imageInstances[0].onerror(); // simulate failed preload
    // Give React a tick; the default must still be showing.
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('img[alt]');
    expect(img.getAttribute('src')).toBe('/logo-dark.jpg');
  });

  it('no company_logo_url configured: default logo stays, no preload attempted', async () => {
    get.mockResolvedValue({ settings: { company_name: 'Acme Remodeling' } });
    renderLayout();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(imageInstances.length).toBe(0);
    const img = document.querySelector('img[alt]');
    expect(img.getAttribute('src')).toBe('/logo-dark.jpg');
  });

  it('company name loads from config and is never hardcoded to EC for a different company', async () => {
    get.mockResolvedValue({ settings: { company_name: 'Acme Remodeling', company_city: 'Denver', company_state: 'CO' } });
    renderLayout();
    await waitFor(() => expect(screen.getAllByText('Acme Remodeling').length).toBeGreaterThan(0));
    expect(screen.queryByText('EC Construction Group')).toBeFalsy();
    expect(screen.getByText('Denver, CO')).toBeTruthy();
  });

  it('a failed company-settings fetch falls back to this deployment\'s default identity, never a crash', async () => {
    get.mockRejectedValue(new Error('network error'));
    renderLayout();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByText('EC Construction Group').length).toBeGreaterThan(0);
  });
});
