/**
 * SystemHealth.test.jsx — Admin System Health page (redesigned in the
 * System Health UI-consistency + real-integration-audit pass). Proves:
 * admin sees data, non-admin sees an access message (never the data),
 * a disabled module never renders as Disconnected/Degraded, a module whose
 * flag has no real enforcement (sms — a deliberate, permanent exception,
 * see lib/systemHealthChecks.js's MODULE_FLAG_ENFORCED) is never silently
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
      sms: integration({
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
    // sms: module_enabled=false but flag_enforced=false (deliberate,
    // permanent exception — lib/reminderAlerts.js's Twilio critical-alert
    // channel is never gated by design) — real state must come from
    // credential evidence (NOT_CONFIGURED here), never a fabricated DISABLED.
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
          module_enabled: true, flag_enforced: true, state: 'CONFIGURED',
          credential_source: 'webhook_secret', missing_env: [], supports_live_check: false, live_check: null,
          recency: { last_lead_received_at: '2026-01-01T00:00:00Z', total_leads_received: 7 },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/7 total/)).toBeTruthy());
  });

  it('October 2026 incident diagnostics: surfaces the SMS webhook base-URL source and flags the CRM_PUBLIC_URL fallback as a warning', async () => {
    get.mockResolvedValue(fixture({
      integrations: {
        sms: integration({
          module_enabled: true, flag_enforced: false, state: 'CONFIGURED',
          credential_source: 'env', missing_env: [], supports_live_check: true, live_check: null,
          recency: { last_lead_received_at: null, total_leads_received: 0 },
          delivery_failures: { recent_24h: 3, total: 10, last_rejected_at: '2026-10-24T12:00:00Z' },
          webhook_config: {
            base_url_source: 'CRM_PUBLIC_URL_fallback',
            inbound_webhook_url: 'https://crm.ecconstructiongroup.com/api/v1/sms-webhook/inbound',
            status_webhook_url: 'https://crm.ecconstructiongroup.com/api/v1/sms-webhook/status',
          },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/CRM_PUBLIC_URL \(fallback\)/)).toBeTruthy());
    expect(screen.getByText(/Set TWILIO_WEBHOOK_BASE_URL/)).toBeTruthy();
    expect(screen.getByText(/Last inbound SMS received/)).toBeTruthy();
    expect(screen.getByText(/3 rejected deliveries in the last 24h/)).toBeTruthy();
    expect(screen.getByText(/signature verification failed/)).toBeTruthy();
  });

  it('a correctly-configured SMS webhook base URL is shown without a warning', async () => {
    get.mockResolvedValue(fixture({
      integrations: {
        sms: integration({
          module_enabled: true, flag_enforced: false, state: 'CONFIGURED',
          credential_source: 'env', missing_env: [], supports_live_check: true, live_check: null,
          recency: { last_lead_received_at: '2026-10-24T12:00:00Z', total_leads_received: 5 },
          delivery_failures: { recent_24h: 0, total: 0, last_rejected_at: null },
          webhook_config: {
            base_url_source: 'TWILIO_WEBHOOK_BASE_URL',
            inbound_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/inbound',
            status_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/status',
          },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('TWILIO_WEBHOOK_BASE_URL')).toBeTruthy());
    expect(screen.queryByText(/Set TWILIO_WEBHOOK_BASE_URL/)).toBeFalsy();
    expect(screen.queryByText(/rejected deliveries/)).toBeFalsy();
  });

  it('October 2026 report, revised November 2026: shows reply EMAIL notifications as disabled when the gate is off — never a Yaron SMS forward line', async () => {
    get.mockResolvedValue(fixture({
      integrations: {
        sms: integration({
          module_enabled: true, flag_enforced: false, state: 'CONFIGURED',
          credential_source: 'env', missing_env: [], supports_live_check: true, live_check: null,
          recency: { last_lead_received_at: '2026-10-25T20:25:00Z', total_leads_received: 1 },
          delivery_failures: { recent_24h: 0, total: 0, last_rejected_at: null },
          webhook_config: {
            base_url_source: 'TWILIO_WEBHOOK_BASE_URL',
            inbound_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/inbound',
            status_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/status',
          },
          notification_config: { reply_notifications_enabled: false },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/Disabled \(SMS_REPLY_NOTIFICATIONS_ENABLED\)/)).toBeTruthy());
    expect(screen.queryByText(/Yaron/i)).toBeFalsy();
    expect(screen.queryByText(/SMS_REPLY_FORWARD_TO/)).toBeFalsy();
  });

  it('shows reply EMAIL notifications as Enabled once the gate is set — never shows a forward destination number', async () => {
    get.mockResolvedValue(fixture({
      integrations: {
        sms: integration({
          module_enabled: true, flag_enforced: false, state: 'CONFIGURED',
          credential_source: 'env', missing_env: [], supports_live_check: true, live_check: null,
          recency: { last_lead_received_at: '2026-10-25T20:25:00Z', total_leads_received: 1 },
          delivery_failures: { recent_24h: 0, total: 0, last_rejected_at: null },
          webhook_config: {
            base_url_source: 'TWILIO_WEBHOOK_BASE_URL',
            inbound_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/inbound',
            status_webhook_url: 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/status',
          },
          notification_config: { reply_notifications_enabled: true },
        }),
      },
    }));
    const { container } = render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/\+1\d{10}/);
  });

  it('November 2026 root-cause fix: a disabled scheduled estimate sync is shown distinctly, with last success/attempt and a warning', async () => {
    const staleAt = '2026-09-10T21:09:27Z';
    get.mockResolvedValue(fixture({
      integrations: {
        handoff_estimates_sync: integration({
          module_enabled: true, flag_enforced: false, state: 'DEGRADED',
          credential_source: 'database', missing_env: [], supports_live_check: false,
          live_check: {
            ok: false, degraded: true,
            message: 'Scheduled estimate sync is disabled (QB_SYNC_CRON_ENABLED=false), and no recent webhook-triggered sync activity was found either.',
            checked_at: new Date().toISOString(),
          },
          recency: { total_estimates: 174, matched: 158, unmatched: 16, last_synced_at: staleAt },
          scheduled_sync: { enabled: false, last_successful_sync_at: staleAt, last_attempted_at: staleAt },
          webhook_sync: { last_triggered_at: null, recently_active: false },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/Disabled \(QB_SYNC_CRON_ENABLED=false\)/)).toBeTruthy());
    expect(screen.getByText(/174 estimates synced/)).toBeTruthy();
    expect(screen.getByText(/The scheduled full rescan is not running/)).toBeTruthy();
    expect(screen.getByText(/No recent activity/)).toBeTruthy();
  });

  it('recent webhook activity never masks a disabled scheduled sync — both are shown, never collapsed into "healthy"', async () => {
    const staleAt = '2026-09-10T21:09:27Z';
    const recentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    get.mockResolvedValue(fixture({
      integrations: {
        handoff_estimates_sync: integration({
          module_enabled: true, flag_enforced: false, state: 'DEGRADED',
          credential_source: 'database', missing_env: [], supports_live_check: false,
          live_check: {
            ok: false, degraded: true,
            message: `Scheduled estimate sync is disabled (QB_SYNC_CRON_ENABLED=false). The webhook last triggered a sync ${recentAt} — estimates may still be updating via webhook or manual sync, but the scheduled full rescan is NOT running.`,
            checked_at: new Date().toISOString(),
          },
          recency: { total_estimates: 180, matched: 160, unmatched: 20, last_synced_at: recentAt },
          scheduled_sync: { enabled: false, last_successful_sync_at: staleAt, last_attempted_at: staleAt },
          webhook_sync: { last_triggered_at: recentAt, recently_active: true },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText(/Disabled \(QB_SYNC_CRON_ENABLED=false\)/)).toBeTruthy());
    expect(screen.getByText(/Recently active/)).toBeTruthy();
    // State badge must still read Degraded, never Connected, however recent
    // the webhook activity is.
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeFalsy();
  });

  it('an enabled, recently-successful scheduled sync shows Enabled with no warning', async () => {
    const recentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    get.mockResolvedValue(fixture({
      integrations: {
        handoff_estimates_sync: integration({
          module_enabled: true, flag_enforced: false, state: 'CONNECTED',
          credential_source: 'database', missing_env: [], supports_live_check: false,
          live_check: { ok: true, degraded: false, message: `Last automatic QuickBooks estimate sync completed ${recentAt}.`, checked_at: new Date().toISOString() },
          recency: { total_estimates: 174, matched: 158, unmatched: 16, last_synced_at: recentAt },
          scheduled_sync: { enabled: true, last_successful_sync_at: recentAt, last_attempted_at: recentAt },
          webhook_sync: { last_triggered_at: null, recently_active: false },
        }),
      },
    }));
    render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Enabled')).toBeTruthy());
    expect(screen.queryByText(/scheduled full rescan is not running/)).toBeFalsy();
  });

  it('never renders a secret-looking value', async () => {
    get.mockResolvedValue(fixture());
    const { container } = render(<SystemHealth />);
    await waitFor(() => expect(screen.getByText('Acme Remodeling')).toBeTruthy());
    expect(container.innerHTML).not.toMatch(/encrypted_payload|refresh_token|client_secret/i);
  });
});
