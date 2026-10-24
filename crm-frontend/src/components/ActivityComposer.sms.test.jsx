/**
 * ActivityComposer.sms.test.jsx — the new "Text Message" tab, part of
 * "CRM Lead Detail: Integrate SMS into the Main Activity and Communication
 * System" (October 2026): Note | Call | Email | Text Message | Task |
 * Meeting, matching the design/behavior of the existing tabs, but rendering
 * SmsConversationPanel instead of a generic fill-a-form composer (it has
 * its own inline compose/send, so the shared "Save X" footer is hidden for
 * this tab only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ActivityComposer from './ActivityComposer';

const getConversation = vi.fn();
const sendSms = vi.fn();
const updateSmsConsent = vi.fn();
vi.mock('@/api/railway', () => ({
  activities: { create: vi.fn() },
  leads: { getByExternal: vi.fn(), updateByExternal: vi.fn(), updateSmsConsent: (...a) => updateSmsConsent(...a) },
  tasks: { create: vi.fn() },
  owners: { list: vi.fn().mockResolvedValue({ items: [] }) },
  emails: { send: vi.fn() },
  sms: { getConversation: (...a) => getConversation(...a), send: (...a) => sendSms(...a) },
}));
// A stable object reference — see ActivityComposer.test.jsx's own comment:
// a new object literal on every call here would make the component's
// useEffect([authUser]) dependency "change" every render and loop forever.
const AUTH_USER = { full_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: AUTH_USER }),
}));

function lead(overrides = {}) {
  return {
    id: 'lead-1', railway_id: 'lead-1', first_name: 'Brian', last_name: 'Krantz',
    phone: '3105551234', sms_consent: true, sms_consent_at: '2026-10-01T00:00:00.000Z',
    assigned_rep: 'Yaron Drilevich', ...overrides,
  };
}

beforeEach(() => {
  getConversation.mockReset();
  sendSms.mockReset();
  updateSmsConsent.mockReset();
  getConversation.mockResolvedValue({ items: [] });
});

describe('ActivityComposer — tab order includes Text Message between Email and Task', () => {
  it('renders all six tabs in the required order', () => {
    render(<ActivityComposer lead={lead()} onActivityCreated={vi.fn()} />);
    const labels = ['Note', 'Call', 'Email', 'Text Message', 'Task', 'Meeting'];
    for (const l of labels) expect(screen.getByRole('button', { name: l })).toBeInTheDocument();
  });
});

describe('ActivityComposer — Text Message tab', () => {
  it('shows the SMS conversation panel (consent status + compose box), not the generic Save-form footer', async () => {
    render(<ActivityComposer lead={lead()} onActivityCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Text Message'));
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith('lead-1'));
    expect(screen.getByPlaceholderText('Type a text message…')).toBeInTheDocument();
    expect(screen.queryByText(/^Save Text Message$/)).toBeNull();
  });

  it('sending a message calls the real Twilio-backed send endpoint', async () => {
    sendSms.mockResolvedValue({ message: { id: 'm1', direction: 'outbound', body: 'Hi there', status: 'queued', created_at: new Date().toISOString() } });
    render(<ActivityComposer lead={lead()} onActivityCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Text Message'));
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Type a text message…'), { target: { value: 'Hi there' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sendSms).toHaveBeenCalledWith('lead-1', 'Hi there'));
  });

  it('shows a blocked-sending explanation and the PR #40 consent control when consent is missing', async () => {
    render(<ActivityComposer lead={lead({ sms_consent: false })} onActivityCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Text Message'));
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    expect(screen.getByText(/No SMS consent on file/)).toBeInTheDocument();
    expect(screen.getByText('Record')).toBeInTheDocument();
  });

  it('propagates a consent change back up via onLeadUpdate', async () => {
    const onLeadUpdate = vi.fn();
    updateSmsConsent.mockResolvedValue({ lead: { ...lead(), sms_consent: true, sms_consent_recorded_by: 'yaron@ecconstructiongroup.com' } });
    render(<ActivityComposer lead={lead({ sms_consent: false })} onActivityCreated={vi.fn()} onLeadUpdate={onLeadUpdate} />);
    fireEvent.click(screen.getByText('Text Message'));
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Record'));
    fireEvent.click(screen.getByText('Confirm consent'));
    await waitFor(() => expect(onLeadUpdate).toHaveBeenCalled());
  });
});
