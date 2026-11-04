/**
 * ReminderDeliveryDiagnosticsPanel.test.jsx — the new admin-only, read-only
 * appointment notification diagnostic panel (November 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReminderDeliveryDiagnosticsPanel from './ReminderDeliveryDiagnosticsPanel';

const getAppointmentNotificationDiagnostics = vi.fn();
vi.mock('@/api/railway/reminderDiagnostics', () => ({
  getAppointmentNotificationDiagnostics: (...a) => getAppointmentNotificationDiagnostics(...a),
}));

function lead(overrides = {}) {
  return { id: 'lead-1', ...overrides };
}

beforeEach(() => {
  getAppointmentNotificationDiagnostics.mockReset();
});

describe('ReminderDeliveryDiagnosticsPanel', () => {
  it('does not call the diagnostic on mount — only when "Check" is clicked', () => {
    render(<ReminderDeliveryDiagnosticsPanel lead={lead()} />);
    expect(getAppointmentNotificationDiagnostics).not.toHaveBeenCalled();
  });

  it('calls the diagnostic with the lead id when Check is clicked, and renders the Sent/Delivered/Skipped/Not-yet-due/No-record mix correctly', async () => {
    getAppointmentNotificationDiagnostics.mockResolvedValue({
      found: true,
      lead: { id: 'lead-1', name: 'Deena Novak', sms_consent: false },
      appointment: { date: '2026-11-02', time: '10:00', status: 'scheduled', resolved_from: 'reminder_projection' },
      notifications: {
        email: [
          { window: '48h', outcome: 'not_yet_due', label: 'Not yet due' },
          { window: '24h', outcome: 'not_yet_due', label: 'Not yet due' },
          { window: '12h', outcome: 'sent', label: 'Sent', detail: 'Accepted for sending by Gmail — this system does not track email delivery beyond acceptance.' },
          { window: '2h', outcome: 'not_yet_due', label: 'Not yet due' },
          { window: '30min', outcome: 'not_yet_due', label: 'Not yet due' },
        ],
        sms_confirmation: { window: 'sms_confirmation', outcome: 'no_record', label: 'No record / not verified' },
        sms: [
          { window: 'sms_12h', outcome: 'skipped', label: 'Skipped', reason: 'no_consent' },
          { window: 'sms_2h', outcome: 'not_yet_due', label: 'Not yet due' },
        ],
      },
      generated_at: '2026-11-02T06:01:00.000Z',
    });
    render(<ReminderDeliveryDiagnosticsPanel lead={lead()} />);
    fireEvent.click(screen.getByText('Check'));
    await waitFor(() => expect(getAppointmentNotificationDiagnostics).toHaveBeenCalledWith('lead-1'));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('no_consent')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet due').length).toBeGreaterThan(0);
    expect(screen.getByText('No record / not verified')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument(); // SMS consent: No
  });

  it('shows a plain not-found message rather than crashing when the lead is not found', async () => {
    getAppointmentNotificationDiagnostics.mockResolvedValue({ found: false, message: 'Lead not found.' });
    render(<ReminderDeliveryDiagnosticsPanel lead={lead()} />);
    fireEvent.click(screen.getByText('Check'));
    await waitFor(() => expect(screen.getByText('Lead not found.')).toBeInTheDocument());
  });

  it('shows an error message, never crashes, when the diagnostic call itself fails', async () => {
    getAppointmentNotificationDiagnostics.mockRejectedValue(new Error('network error'));
    render(<ReminderDeliveryDiagnosticsPanel lead={lead()} />);
    fireEvent.click(screen.getByText('Check'));
    await waitFor(() => expect(screen.getByText('network error')).toBeInTheDocument());
  });

  it('never renders "Delivered" or any send confirmation when no data has been fetched yet', () => {
    render(<ReminderDeliveryDiagnosticsPanel lead={lead()} />);
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
  });
});
