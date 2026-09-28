/**
 * QBReconnectBanner.test.jsx — Admin-visible CRM warning when QuickBooks
 * genuinely needs an OAuth reconnect (revoked/expired grant). Never shown to
 * non-admins, never shown for a healthy or unreachable health check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import QBReconnectBanner, { needsQbReconnect } from './QBReconnectBanner';

const apiCall = vi.fn();
vi.mock('@/api/railway/client', () => ({ apiCall: (...a) => apiCall(...a) }));

const admin = { role: 'admin', email: 'a@example.com' };
const renderBanner = (user) => render(<MemoryRouter><QBReconnectBanner user={user} /></MemoryRouter>);

describe('QBReconnectBanner', () => {
  beforeEach(() => { apiCall.mockReset(); });

  it('admin + reconnectRequired → warning with a link to the OAuth reconnect page', async () => {
    apiCall.mockResolvedValue({ connected: false, reconnectRequired: true, credentialStatus: 'revoked' });
    renderBanner(admin);
    const link = await screen.findByRole('link', { name: /Reconnect QuickBooks/ });
    expect(link.getAttribute('href')).toBe('/integrations');
    expect(apiCall).toHaveBeenCalledWith('/qb/health', { method: 'GET' });
  });

  it('healthy connection (even with an expired 1h access token) → nothing shown', async () => {
    apiCall.mockResolvedValue({ connected: true, reconnectRequired: false, tokenExpired: true, credentialStatus: 'connected' });
    renderBanner(admin);
    await waitFor(() => expect(apiCall).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('health endpoint unreachable → nothing shown (a blip is not a disconnect)', async () => {
    apiCall.mockImplementation(async () => { throw new Error('network'); });
    renderBanner(admin);
    await waitFor(() => expect(apiCall).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('non-admin users never see it and never poll', () => {
    renderBanner({ role: 'sales_rep' });
    expect(apiCall).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('needsQbReconnect', () => {
    expect(needsQbReconnect(null)).toBe(false);
    expect(needsQbReconnect({ reconnectRequired: false, credentialStatus: 'connected' })).toBe(false);
    expect(needsQbReconnect({ reconnectRequired: false, credentialStatus: 'revoked' })).toBe(true);
    expect(needsQbReconnect({ reconnectRequired: true })).toBe(true);
  });
});
