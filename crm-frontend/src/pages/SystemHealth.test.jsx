/**
 * SystemHealth.test.jsx — Admin System Health page (PRODUCTIZATION PHASE 2,
 * Section 8). Proves: admin sees data, non-admin sees an access message
 * (never the data), disabled integrations render "Disabled" not "Error",
 * and no secret value ever appears in the rendered output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SystemHealth from './SystemHealth';

const get = vi.fn();
vi.mock('@/api/railway/systemInfo', () => ({
  get: (...a) => get(...a),
}));

let mockUser = { role: 'admin', email: 'admin@acme.example' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function fixture(overrides = {}) {
  return {
    product_version: '1.0.0',
    build_commit: 'abc123def456',
    installation: { company_name: 'Acme Remodeling', installation_id: 'inst-1' },
    schema: { migrations_applied: 45, last_migration_applied_at: new Date().toISOString() },
    integrations: {
      quickbooks: { module_enabled: true, env_configured: true, missing_env: [], connection: { state: 'CONNECTED' } },
      meta: { module_enabled: false, env_configured: false, missing_env: ['META_APP_SECRET'], connection: { state: 'DISABLED' } },
    },
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
  });

  it('non-admin sees an access message, never installation data', async () => {
    mockUser = { role: 'sales_rep', email: 'rep@acme.example' };
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    expect(screen.getByText(/admins only/i)).toBeTruthy();
    expect(screen.queryByText('Acme Remodeling')).toBeFalsy();
  });

  it('a disabled module never renders as an error state', async () => {
    get.mockResolvedValue(fixture());
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Disabled')).toBeTruthy());
    expect(screen.queryByText('Error')).toBeFalsy();
  });

  it('never renders a secret-looking value', async () => {
    get.mockResolvedValue(fixture());
    const { container } = render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());
    expect(container.innerHTML).not.toMatch(/encrypted_payload|refresh_token|client_secret/i);
  });
});
