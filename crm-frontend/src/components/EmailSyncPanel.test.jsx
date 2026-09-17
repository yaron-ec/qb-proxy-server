/**
 * EmailSyncPanel.test.jsx — Gmail (re)connection status + reconnect UI.
 *
 * Production defect: after adding the gmail.readonly OAuth scope, there was
 * no safe way for an admin to actually grant it — the only UI affordance was
 * a dead `<a href="/integrations">Connect Gmail</a>` link (Integrations.jsx
 * has no Gmail section at all). Fixed by wiring a real "Reconnect Gmail"
 * button (admin-only) through /api/v1/admin/gmail-oauth/*, and by using that
 * endpoint's has_send_access/has_read_access flags to show a truthful,
 * distinct "connected, send-only" vs "connected, read available" state
 * instead of a single binary connected/not-connected signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EmailSyncPanel from './EmailSyncPanel';

const getStatus = vi.fn();
const reconnect = vi.fn();
vi.mock('@/api/railway/gmailOAuth', () => ({
  getStatus: (...a) => getStatus(...a),
  reconnect: (...a) => reconnect(...a),
}));

const gmailProfile = vi.fn();
vi.mock('@/lib/railwayApi', () => ({
  isLoggedIn: () => true,
  gmailProfile: (...a) => gmailProfile(...a),
  gmailMessages: vi.fn().mockResolvedValue({ messages: [] }),
}));

vi.mock('@/api/railway/leads', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/activities', () => ({ list: vi.fn().mockResolvedValue({ items: [] }), create: vi.fn() }));

// Stable reference — see ActivityComposer.test.jsx for why a fresh object
// literal per render would loop useEffect([...]) dependencies forever.
let AUTH_USER = { full_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: AUTH_USER }),
}));

beforeEach(() => {
  getStatus.mockReset();
  reconnect.mockReset();
  gmailProfile.mockReset();
  AUTH_USER = { full_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
});

describe('EmailSyncPanel — admin, read access available', () => {
  it('shows Gmail Connected with Sync Now, no reconnect banner', async () => {
    getStatus.mockResolvedValue({ connected: true, account: 'yaron@ecconstructiongroup.com', has_send_access: true, has_read_access: true, scope_recorded: true });
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Connected')).toBeTruthy());
    expect(screen.queryByText('Reconnect Gmail')).toBeNull();
    expect(screen.getByText('Sync Now')).toBeTruthy();
  });
});

describe('EmailSyncPanel — admin, send-only (the exact pre-fix production state)', () => {
  it('shows the known insufficient-scope state with a working Reconnect Gmail button', async () => {
    getStatus.mockResolvedValue({ connected: true, account: 'yaron@ecconstructiongroup.com', has_send_access: true, has_read_access: false, scope_recorded: true });
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Connected — Read Access Not Granted')).toBeTruthy());
    const btn = screen.getByText('Reconnect Gmail');
    fireEvent.click(btn);
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });
});

describe('EmailSyncPanel — admin, not connected at all', () => {
  it('shows Reconnect Gmail (not the old dead /integrations link)', async () => {
    getStatus.mockResolvedValue({ connected: false });
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Not Available')).toBeTruthy());
    expect(screen.queryByText('Connect Gmail')).toBeNull();
    const btn = screen.getByText('Reconnect Gmail');
    expect(btn.closest('a')).toBeNull(); // a real action, not the old dead anchor link
    fireEvent.click(btn);
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });

  it('surfaces a reconnect failure without crashing', async () => {
    getStatus.mockResolvedValue({ connected: false });
    reconnect.mockRejectedValue(new Error('Gmail OAuth is not configured on the server.'));
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Not Available')).toBeTruthy());
    fireEvent.click(screen.getByText('Reconnect Gmail'));
    await waitFor(() => expect(screen.getByText('Gmail OAuth is not configured on the server.')).toBeTruthy());
  });
});

describe('EmailSyncPanel — non-admin', () => {
  it('never calls the admin-only status endpoint, never shows a Reconnect button', async () => {
    AUTH_USER = { full_name: 'Some Rep', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' };
    gmailProfile.mockRejectedValue(Object.assign(new Error('forbidden: insufficient role'), { status: 403 }));
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Not Available')).toBeTruthy());
    expect(getStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Reconnect Gmail')).toBeNull();
    expect(screen.getByText('Ask an admin to reconnect Gmail.')).toBeTruthy();
  });

  it('shows Gmail Connected when the mailbox-read check succeeds', async () => {
    AUTH_USER = { full_name: 'Some Rep', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' };
    gmailProfile.mockResolvedValue({ emailAddress: 'yaron@ecconstructiongroup.com' });
    render(<EmailSyncPanel />);
    await waitFor(() => expect(screen.getByText('Gmail Connected')).toBeTruthy());
    expect(getStatus).not.toHaveBeenCalled();
  });
});
