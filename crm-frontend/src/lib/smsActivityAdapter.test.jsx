import { describe, it, expect } from 'vitest';
import { smsAuthorLabel, smsActivityId, smsMessageToActivity } from './smsActivityAdapter';

describe('smsAuthorLabel', () => {
  it('an inbound message is always "Customer", regardless of sent_by', () => {
    expect(smsAuthorLabel({ direction: 'inbound', sent_by: null })).toBe('Customer');
  });
  it('a manual outbound send shows the real rep email (sent_by)', () => {
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'mike@ecconstructiongroup.com' })).toBe('mike@ecconstructiongroup.com');
  });
  it('the automated booking confirmation is labeled distinctly', () => {
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'system:booking_confirmation' })).toMatch(/Booking Confirmation/);
  });
  it('the automated 12h reminder is labeled distinctly, and the deferred variant says so', () => {
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'system:reminder_12h' })).toMatch(/12h Reminder/);
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'system:reminder_12h_deferred' })).toMatch(/deferred/);
  });
  it('the automated 2h reminder is labeled distinctly, and the deferred variant says so', () => {
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'system:reminder_2h' })).toMatch(/2h Reminder/);
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: 'system:reminder_2h_deferred' })).toMatch(/deferred/);
  });
  it('an outbound send with no sent_by at all falls back to "System", never blank', () => {
    expect(smsAuthorLabel({ direction: 'outbound', sent_by: null })).toBe('System');
  });
});

describe('smsActivityId', () => {
  it('is prefixed so it can never collide with (or be mistaken for) a real activities.id', () => {
    expect(smsActivityId({ id: 'abc-123' })).toBe('sms-abc-123');
  });
});

describe('smsMessageToActivity', () => {
  const row = {
    id: 'm1', lead_id: 'lead-1', direction: 'outbound', from_number: '+18185551234', to_number: '+13105551234',
    body: 'Your appointment is confirmed.', twilio_sid: 'SM123', status: 'delivered', error_code: null,
    error_message: null, sent_by: 'system:booking_confirmation', keyword: null, created_at: '2026-10-24T18:00:00.000Z',
  };

  it('produces an activity-shaped object compatible with ActivityCard', () => {
    const a = smsMessageToActivity(row);
    expect(a.id).toBe('sms-m1');
    expect(a.type).toBe('sms');
    expect(a.content).toBe(row.body);
    expect(a.timestamp).toBe(row.created_at);
    expect(a.author).toMatch(/Booking Confirmation/);
  });

  it('carries delivery status, error info, and direction in metadata — never dropped', () => {
    const failed = smsMessageToActivity({ ...row, status: 'failed', error_code: '30003', error_message: 'Unreachable' });
    expect(failed.metadata.status).toBe('failed');
    expect(failed.metadata.error_code).toBe('30003');
    expect(failed.metadata.error_message).toBe('Unreachable');
    expect(failed.metadata.direction).toBe('outbound');
    expect(failed.metadata.twilio_sid).toBe('SM123');
  });

  it('carries the detected keyword (STOP/START/HELP) when present, for an inbound message', () => {
    const stop = smsMessageToActivity({ ...row, direction: 'inbound', sent_by: null, keyword: 'STOP' });
    expect(stop.metadata.keyword).toBe('STOP');
    expect(stop.author).toBe('Customer');
  });
});
