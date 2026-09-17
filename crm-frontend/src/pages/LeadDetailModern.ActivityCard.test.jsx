/**
 * LeadDetailModern.ActivityCard.test.jsx — regression coverage for real
 * Gmail correspondence rendering in Lead Detail's Activity feed (Item 4F):
 * inbound/outbound, date/time, From/To, a body preview, an attachment
 * indicator, and an "expand"/open link to the full message — without
 * dumping raw HTML or a giant quoted thread into the timeline.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityCard } from './LeadDetailModern';

function baseActivity(overrides = {}) {
  return {
    id: 'a1', type: 'email', source: 'gmail', content: 'Question about my kitchen',
    author: 'brian.krantz@example.com', timestamp: '2026-08-01T10:00:00.000Z',
    metadata: {
      direction: 'inbound', from: 'brian.krantz@example.com', to: 'yaron@ecconstructiongroup.com',
      snippet: 'Hi, just wanted to follow up on the estimate we discussed...',
      has_attachment: false, gmail_message_id: 'msg123', gmail_thread_id: 'thread123',
      email_subject: 'Question about my kitchen',
    },
    ...overrides,
  };
}

describe('ActivityCard — real Gmail correspondence', () => {
  it('shows "Received" for an inbound message', () => {
    render(<ActivityCard activity={baseActivity()} currentUser={null} />);
    expect(screen.getByText('Received')).toBeInTheDocument();
  });

  it('shows "Sent" for an outbound message, with the To address (not From)', () => {
    const activity = baseActivity({
      author: 'yaron@ecconstructiongroup.com',
      metadata: { ...baseActivity().metadata, direction: 'outbound', from: 'yaron@ecconstructiongroup.com', to: 'brian.krantz@example.com' },
    });
    const { container } = render(<ActivityCard activity={activity} currentUser={null} />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(container.textContent).toMatch(/To:\s*brian\.krantz@example\.com/);
  });

  it('shows a body snippet preview, not the full/raw message', () => {
    render(<ActivityCard activity={baseActivity()} currentUser={null} />);
    expect(screen.getByText(/just wanted to follow up/)).toBeInTheDocument();
  });

  it('shows an attachment indicator only when the message actually has one', () => {
    const { rerender, container } = render(<ActivityCard activity={baseActivity()} currentUser={null} />);
    expect(container.querySelector('svg[aria-label="Has attachment"]')).toBeNull();

    const withAttachment = baseActivity({ metadata: { ...baseActivity().metadata, has_attachment: true } });
    rerender(<ActivityCard activity={withAttachment} currentUser={null} />);
    expect(container.querySelector('svg[aria-label="Has attachment"]')).toBeInTheDocument();
  });

  it('links out to the full message in Gmail rather than rendering raw HTML inline', () => {
    render(<ActivityCard activity={baseActivity()} currentUser={null} />);
    const link = screen.getByText('Open in Gmail').closest('a');
    expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#all/msg123');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('never renders raw HTML — dangerouslySetInnerHTML is not used for the snippet', () => {
    const activity = baseActivity({ metadata: { ...baseActivity().metadata, snippet: '<img src=x onerror=alert(1)>' } });
    const { container } = render(<ActivityCard activity={activity} currentUser={null} />);
    // The snippet renders as literal text, not as a live <img> tag.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('a plain manually-logged email activity (no metadata.direction) renders exactly as before — no Sent/Received badge fabricated', () => {
    const manual = { id: 'a2', type: 'email', source: 'manual', content: 'Called client, sent follow-up email manually', author: 'yaron@ecconstructiongroup.com', timestamp: '2026-08-01T10:00:00.000Z', metadata: {} };
    render(<ActivityCard activity={manual} currentUser={null} />);
    expect(screen.queryByText('Sent')).toBeNull();
    expect(screen.queryByText('Received')).toBeNull();
  });
});
