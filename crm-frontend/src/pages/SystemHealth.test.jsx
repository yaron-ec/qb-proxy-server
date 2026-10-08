/**
 * SystemHealth.test.jsx — Admin System Health page (redesigned in the
 * System Health UI-consistency + real-integration-audit pass). Proves:
 * admin sees data, non-admin sees an access message (never the data),
 * a disabled module never renders as Disconnected/Degraded, a module whose
 * flag has no real enforcement (gmail/sms/website_intake) is never silently
 * reported as Disabled from the flag alone, "Run Live Checks" triggers the
 * ?verify=1 path distinctly from the default fast refresh, and no secret
 * value ever appears in the rendered output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SystemHealth from './SystemHealth';

const get = vi.fn();
vi.mock('@/api/railway/systemInfo', () => ({
  get: (...a) => get(...a),
}));

let mockUser = { role: 'admin', email: 'admin@acme.example' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function integration(overrides = {}) {
  return {
    module_enabled: true,
    flag_enforced: true,
    state: 'CONNECTED',
    credential_source: 'database',
    missing_env: [],
    supports_live_check: true,
    live_check: { ok: true, degraded: false, message: 'Verified via a read-only call.', checked_at: new Date().toISOString() },
    recency: null,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    product_version: '1.0.0',
    build_commit: 'abc123def456',
    installation: { company_name: 'Acme Remodeling', installation_id: 'inst-1' },
    schema: { migrations_applied: 45, last_migration_applied_at: new Date().toISOString() },
    integrations: {
      quickbooks: integration({ state: 'CONNECTED' }),
      meta: integration({
        module_enabled: false, flag_enforced: true, state: 'DISABLED',
        credential_source: 'none', missing_env: ['META_APP_SECRET'], supports_live_check: false, live_check: null,
      }),
      gmail: integration({
        module_enabled: false, flag_enforced: false, state: 'NOT_CONFIGURED',
        credential_source: 'none', missing_env: [], supports_live_check: true, live_check: null,
      }),
    },
    verified: false,
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => { get.mockReset(); mockUser = { role: 'admin', email: 'admin@acme.example' }; });

describe('SystemHealth', () => {
  it('admin sees installation identity and integration states', async () => {
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(get).toHaveBeenCalledWith({ verify: false });
  });

  it('non-admin sees an access message, never installation data', async () => {
    mockUser = { role: 'sales_rep', email: 'rep@acme.example' };
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    expect(screen.getByText(/admins only/i)).toBeTruthy();
    expect(screen.queryByText('Acme Remodeling')).toBeFalsy();
  });

  it('a disabled module never renders as Disconnected or Degraded', async () => {
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Disabled')).toBeTruthy());
    expect(screen.queryByText('Disconnected')).toBeFalsy();
    expect(screen.queryByText('Degraded')).toBeFalsy();
  });

  it('a module with an unenforced flag is never reported Disabled from the flag alone', async () => {
    // gmail: module_enabled=false but flag_enforced=false (known, documented
    // enforcement gap) — real state must come from credential evidence
    // (NOT_CONFIGURED here), never a fabricated DISABLED.
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Not Configured')).toBeTruthy());
    expect(screen.getByText(/toggle has no effect yet/i)).toBeTruthy();
  });

  it('"Run Live Checks" requests the verify=1 path distinctly from Refresh', async () => {
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());

    get.mockResolvedValue(fixture({ verified: true }));
    fireEvent.click(screen.getByText('Run Live Checks'));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ verify: true }));
    await waitFor(() => expect(screen.getByText(/live connectivity checks included/i)).toBeTruthy());
  });

  it('surfaces recency evidence for inbound-only webhook integrations', async () => {
    get.mockResolvedValue(fixture({
      integrations: {
        website_intake: integration({
          module_enabled: false, flag_enforced: false, state: 'NOT_CONFIGURED',
          credential_source: 'none', missing_env: ['WEBSITE_LEAD_WEBHOOK_SECRET'], supports_live_check: false, live_check: null,
          recency: { last_lead_received_at: '2026-01-01T00:00:00Z', total_leads_received: 7 },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/7 total/)).toBeTruthy());
  });

  it('never renders a secret-looking value', async () => {
    get.mockResolvedValue(fixture());
    const { container } = render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());
    expect(container.innerHTML).not.toMatch(/encrypted_payload|refresh_token|client_secret/i);
  });
});
