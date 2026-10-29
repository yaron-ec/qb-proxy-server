/**
 * Integrations.qbAuth.test.jsx — regression coverage for the October 2026
 * QuickBooks reliability audit's frontend change: the Connect/Disconnect
 * QuickBooks buttons are now hidden from non-admin users. This is UX only
 * — the real enforcement is server-side (server.js's
 * requireProxySecretOrRole on /auth/connect, /auth/callback,
 * /auth/disconnect, see test/qbRouteAuth.test.js and
 * test/qbLegacyWriteRouteSecurity.test.js on the backend) — but a visible
 * button that always 403s is still worth hiding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Integrations from './Integrations';

function renderPage() {
  return render(<MemoryRouter><Integrations /></MemoryRouter>);
}

vi.mock('@/components/IntegrationSyncStatus', () => ({ default: () => <div /> }));
vi.mock('@/components/EstimateSyncDiagnostics', () => ({ default: () => <div /> }));
vi.mock('@/components/CalendarSyncMonitor', () => ({ default: () => <div /> }));
vi.mock('@/components/CalendarAuditPanel', () => ({ default: () => <div /> }));
vi.mock('@/components/MeetingPipelineAudit', () => ({ default: () => <div /> }));
vi.mock('@/components/QBDiagnosticsPanel', () => ({ default: () => <div /> }));
vi.mock('@/components/UnmatchedEstimatesPanel', () => ({ default: () => <div />, isTestCustomer: () => false }));
vi.mock('@/lib/syncContext', () => ({
  useSync: () => ({ addJob: vi.fn(), startJob: vi.fn(), completeJob: vi.fn(), failJob: vi.fn(), isRunning: () => false, activeJobs: [] }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

let meUser = { role: 'admin' };
vi.mock('@/lib/railwayApi', () => ({ me: () => Promise.resolve({ user: meUser }) }));
vi.mock('@/api/railway/handoffEstimates', () => ({ list: () => Promise.resolve({ items: [] }) }));
vi.mock('@/lib/railwayClient', () => ({
  railwayRequest: (path) => (path === '/qb/auth-status' ? Promise.resolve({ connected: true, connected_at: null }) : Promise.resolve({})),
  normalizeIntegrationError: (e) => String(e?.message || e),
}));

beforeEach(() => { meUser = { role: 'admin' }; });

describe('Integrations — QuickBooks Connect/Disconnect is admin-only', () => {
  it('an admin sees the Reconnect/Disconnect control', async () => {
    meUser = { role: 'admin' };
    renderPage();
    await waitFor(() => expect(screen.getByText('QuickBooks Online')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Reconnect')).toBeInTheDocument());
  });

  it('a manager does NOT see the Reconnect/Disconnect control, and sees the explanatory note instead', async () => {
    meUser = { role: 'manager' };
    renderPage();
    await waitFor(() => expect(screen.getByText('QuickBooks Online')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Admin access required/i)).toBeInTheDocument());
    expect(screen.queryByText('Reconnect')).toBeNull();
    expect(screen.queryByText('Connect QuickBooks')).toBeNull();
  });

  it('a sales_rep does NOT see the Reconnect/Disconnect control either', async () => {
    meUser = { role: 'sales_rep' };
    renderPage();
    await waitFor(() => expect(screen.getByText('QuickBooks Online')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Admin access required/i)).toBeInTheDocument());
  });
});
