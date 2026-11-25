/**
 * AppointmentReminderPanel.test.jsx — November 2026 "SMS consent
 * visibility" CRM reliability request. This panel sits right next to the
 * appointment itself (unlike SmsConversationPanel.jsx's own consent
 * banner, buried inside the Text Message tab) — a rep looking at an
 * upcoming appointment should see, right here, whether the automated
 * customer SMS reminder will actually fire. Reuses the existing
 * `lead.sms_consent` field, never a new consent concept, never a
 * grant/revoke control of its own (that stays exclusively in
 * SmsConversationPanel.jsx — this is read-only, informational).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AppointmentReminderPanel from './AppointmentReminderPanel';

const getCompanySettings = vi.fn();
vi.mock('@/api/railway/companySettings', () => ({
  get: (...a) => getCompanySettings(...a),
}));

function futureAppointmentLead(overrides = {}) {
  const future = new Date();
  future.setDate(future.getDate() + 3);
  const apptDate = future.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return {
    id: 'lead-1', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
    phone: '3105551234', sms_consent: true,
    appointment_date: apptDate, appointment_time: '10:30', appointment_type: 'Meeting',
    ...overrides,
  };
}

beforeEach(() => {
  getCompanySettings.mockReset();
  getCompanySettings.mockResolvedValue(null);
});

describe('AppointmentReminderPanel — SMS consent visibility', () => {
  it('shows no SMS consent warning when consent is on file', async () => {
    render(<AppointmentReminderPanel lead={futureAppointmentLead({ sms_consent: true })} />);
    await waitFor(() => expect(screen.getByText('Meeting')).toBeInTheDocument());
    expect(screen.queryByText(/automated SMS reminders will not be sent/)).not.toBeInTheDocument();
  });

  it('shows a clear, non-intrusive warning when SMS consent is missing and the lead has a phone', async () => {
    render(<AppointmentReminderPanel lead={futureAppointmentLead({ sms_consent: false })} />);
    await waitFor(() => expect(screen.getByText(/automated SMS reminders will not be sent/)).toBeInTheDocument());
  });

  it('shows the same warning when sms_consent is simply absent (undefined), never treating absence as consent', async () => {
    const lead = futureAppointmentLead();
    delete lead.sms_consent;
    render(<AppointmentReminderPanel lead={lead} />);
    await waitFor(() => expect(screen.getByText(/automated SMS reminders will not be sent/)).toBeInTheDocument());
  });

  it('never shows the SMS warning when the lead has no phone number at all (nothing to warn about)', async () => {
    render(<AppointmentReminderPanel lead={futureAppointmentLead({ phone: null, sms_consent: false })} />);
    await waitFor(() => expect(screen.getByText('Meeting')).toBeInTheDocument());
    expect(screen.queryByText(/automated SMS reminders will not be sent/)).not.toBeInTheDocument();
  });

  it('never grants or changes consent itself — purely informational, no action control for it in this panel', async () => {
    render(<AppointmentReminderPanel lead={futureAppointmentLead({ sms_consent: false })} />);
    await waitFor(() => expect(screen.getByText(/automated SMS reminders will not be sent/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /consent/i })).not.toBeInTheDocument();
  });

  it('renders nothing at all (including no SMS warning) when there is no upcoming appointment', () => {
    const { container } = render(<AppointmentReminderPanel lead={{ id: 'lead-2', phone: '3105551234', sms_consent: false }} />);
    expect(container.firstChild).toBeNull();
  });
});
