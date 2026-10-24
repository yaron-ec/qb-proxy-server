/**
 * LeadDetailModern.smsActivity.test.jsx — regression coverage for SMS
 * entries merged into the central chronological Lead Activity timeline
 * (lib/smsActivityAdapter.js#smsMessageToActivity -> ActivityCard), part of
 * "CRM Lead Detail: Integrate SMS into the Main Activity and Communication
 * System" (October 2026). sms_messages stays the one source of truth — this
 * never writes a mirror activities row; ActivityCard just needs to render
 * the synthetic 'sms' entry correctly and never offer to edit/delete it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityCard } from './LeadDetailModern';
import { smsMessageToActivity } from '@/lib/smsActivityAdapter';

function smsActivity(row = {}) {
  return smsMessageToActivity({
    id: 'm1', direction: 'outbound', from_number: '+18185930874', to_number: '+13105551234',
    body: 'Hi Sarah! Your appointment is confirmed for Thu, Oct 29 at 2:00 PM.',
    twilio_sid: 'SM1', status: 'delivered', error_code: null, error_message: null,
    sent_by: 'system:booking_confirmation', keyword: null, created_at: '2026-10-24T18:00:00.000Z',
    ...row,
  });
}

describe('ActivityCard — SMS entries in the main timeline', () => {
  it('labels the entry "Text Message" with its own color, distinct from Note/Call/Email', () => {
    render(<ActivityCard activity={smsActivity()} currentUser={null} />);
    expect(screen.getByText('Text Message')).toBeInTheDocument();
  });

  it('shows "Sent" for an outbound message and "Received" for an inbound one', () => {
    const { rerender } = render(<ActivityCard activity={smsActivity()} currentUser={null} />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    rerender(<ActivityCard activity={smsActivity({ direction: 'inbound', sent_by: null, body: 'Sounds good, see you then!' })} currentUser={null} />);
    expect(screen.getByText('Received')).toBeInTheDocument();
  });

  it('shows the delivery status for an outbound message: queued/sent/delivered/failed/undelivered', () => {
    const { rerender } = render(<ActivityCard activity={smsActivity({ status: 'delivered' })} currentUser={null} />);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    rerender(<ActivityCard activity={smsActivity({ status: 'failed', error_code: '30003', error_message: 'Unreachable destination' })} currentUser={null} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/Unreachable destination/)).toBeInTheDocument();
    expect(screen.getByText(/30003/)).toBeInTheDocument();
  });

  it('never shows a delivery-status badge for an inbound (customer) message', () => {
    render(<ActivityCard activity={smsActivity({ direction: 'inbound', sent_by: null, status: 'received' })} currentUser={null} />);
    expect(screen.queryByText('Received').closest('div')).not.toHaveTextContent('Delivered');
  });

  it('distinguishes a manual rep send, an automated confirmation, and a customer reply by author label', () => {
    const { rerender } = render(<ActivityCard activity={smsActivity({ sent_by: 'mike@ecconstructiongroup.com' })} currentUser={null} />);
    expect(screen.getByText('mike@ecconstructiongroup.com')).toBeInTheDocument();
    rerender(<ActivityCard activity={smsActivity({ sent_by: 'system:booking_confirmation' })} currentUser={null} />);
    expect(screen.getByText(/Booking Confirmation/)).toBeInTheDocument();
    rerender(<ActivityCard activity={smsActivity({ direction: 'inbound', sent_by: null })} currentUser={null} />);
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('shows the detected STOP/START/HELP keyword when present', () => {
    render(<ActivityCard activity={smsActivity({ direction: 'inbound', sent_by: null, keyword: 'STOP' })} currentUser={null} />);
    expect(screen.getByText(/Keyword: STOP/)).toBeInTheDocument();
  });

  it('never offers edit/delete for an SMS entry, even for an admin — it is a read-through of sms_messages, not an activities row', () => {
    const admin = { role: 'admin', full_name: 'Admin User', email: 'admin@ecconstructiongroup.com' };
    const { container } = render(<ActivityCard activity={smsActivity()} currentUser={admin} />);
    expect(container.querySelector('[aria-label="Edit note"]')).toBeNull();
    expect(container.querySelector('[aria-label="Delete note"]')).toBeNull();
  });

  it('renders the message body as plain text content', () => {
    render(<ActivityCard activity={smsActivity()} currentUser={null} />);
    expect(screen.getByText(/Your appointment is confirmed/)).toBeInTheDocument();
  });
});
