/**
 * SmsConversationPanel.test.jsx — the SMS conversation view now embedded in
 * Lead Detail's central "Text Message" tab (previously a separate left-
 * sidebar SmsPanel.jsx, removed once this replaced it everywhere).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SmsConversationPanel from './SmsConversationPanel';

const getConversation = vi.fn();
const sendSms = vi.fn();
const updateSmsConsent = vi.fn();
vi.mock('@/api/railway', () => ({
  sms: { getConversation: (...a) => getConversation(...a), send: (...a) => sendSms(...a) },
  leads: { updateSmsConsent: (...a) => updateSmsConsent(...a) },
}));

function lead(overrides = {}) {
  return { id: 'lead-1', phone: '3105551234', sms_consent: true, ...overrides };
}

beforeEach(() => {
  getConversation.mockReset();
  sendSms.mockReset();
  updateSmsConsent.mockReset();
  getConversation.mockResolvedValue({ items: [] });
});

describe('SmsConversationPanel', () => {
  it('shows a clear no-phone state and never attempts to load a conversation', async () => {
    render(<SmsConversationPanel lead={lead({ phone: null })} />);
    expect(screen.getByText(/No phone number on file/)).toBeInTheDocument();
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('renders the full conversation: outbound/inbound, delivery status, and errors', async () => {
    getConversation.mockResolvedValue({
      items: [
        { id: 'm1', direction: 'outbound', body: 'Your appointment is confirmed.', status: 'delivered', sent_by: 'system:booking_confirmation', created_at: '2026-10-24T18:00:00.000Z' },
        { id: 'm2', direction: 'inbound', body: 'Thanks, see you then!', status: 'received', sent_by: null, created_at: '2026-10-24T18:05:00.000Z' },
        { id: 'm3', direction: 'outbound', body: 'Reminder: your appointment is tomorrow.', status: 'failed', error_code: '30003', error_message: 'Unreachable', sent_by: 'system:reminder_12h', created_at: '2026-10-24T19:00:00.000Z' },
      ],
    });
    render(<SmsConversationPanel lead={lead()} />);
    await waitFor(() => expect(screen.getByText('Your appointment is confirmed.')).toBeInTheDocument());
    expect(screen.getByText('Thanks, see you then!')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/Unreachable/)).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('a rejected send shows the specific, human-readable reason — not a generic failure', async () => {
    sendSms.mockRejectedValue({ data: { error: 'quiet_hours' }, message: 'rejected' });
    render(<SmsConversationPanel lead={lead()} />);
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Type a text message…'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByText(/restricted during quiet hours/)).toBeInTheDocument());
  });

  it('a successful send clears the draft and appends the new message optimistically', async () => {
    sendSms.mockResolvedValue({ message: { id: 'm9', direction: 'outbound', body: 'Hello', status: 'queued', created_at: new Date().toISOString() } });
    render(<SmsConversationPanel lead={lead()} />);
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    const textarea = screen.getByPlaceholderText('Type a text message…');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getAllByText('Hello').length).toBeGreaterThan(0));
    expect(textarea.value).toBe('');
  });
});
