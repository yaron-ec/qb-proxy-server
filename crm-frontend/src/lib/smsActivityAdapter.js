// smsActivityAdapter — turns a raw sms_messages row (routes/sms.js's
// GET /api/v1/leads/:id/sms) into an "activity"-shaped object so it can be
// merged into the SAME chronological feed Notes/Calls/Emails/Tasks/Meetings
// already render through (pages/LeadDetailModern.jsx's `activities` array +
// ActivityCard). sms_messages stays the ONE source of truth — this never
// writes a mirror row into the activities table, it only reshapes data
// already fetched for display.
//
// `sent_by` is the one field that already tells the whole story of WHO/WHAT
// sent an outbound message (lib/booking/bookingService.js /
// lib/reminderEngine.js / routes/sms.js — see CLAUDE.md's SMS sections):
// a rep's email for a manual send, 'system:booking_confirmation' /
// 'system:reminder_12h' / 'system:reminder_2h' (+ '_deferred') for automated
// sends, and NULL for an inbound customer reply.
export function smsAuthorLabel(row) {
  if (row.direction === 'inbound') return 'Customer';
  const sentBy = row.sent_by;
  if (!sentBy) return 'System';
  if (sentBy === 'system:booking_confirmation') return 'Automated — Booking Confirmation';
  if (sentBy.startsWith('system:reminder_12h')) return sentBy.endsWith('_deferred') ? 'Automated — 12h Reminder (deferred)' : 'Automated — 12h Reminder';
  if (sentBy.startsWith('system:reminder_2h')) return sentBy.endsWith('_deferred') ? 'Automated — 2h Reminder (deferred)' : 'Automated — 2h Reminder';
  if (sentBy.startsWith('system:')) return 'Automated';
  return sentBy; // a rep's real email
}

// A stable, collision-free key for React lists / dedup maps — sms_messages
// and activities are different tables with their own UUID PKs, so a bare id
// could theoretically collide; prefixing makes the synthetic entry
// unambiguous and never mistaken for a real activities row (e.g. by
// ActivityCard's edit/delete affordance, which must never target one).
export function smsActivityId(row) {
  return `sms-${row.id}`;
}

export function smsMessageToActivity(row) {
  return {
    id: smsActivityId(row),
    sms_message_id: row.id,
    type: 'sms',
    content: row.body,
    author: smsAuthorLabel(row),
    timestamp: row.created_at,
    created_at: row.created_at,
    source: 'sms',
    metadata: {
      direction: row.direction,
      status: row.status,
      error_code: row.error_code || null,
      error_message: row.error_message || null,
      from_number: row.from_number,
      to_number: row.to_number,
      twilio_sid: row.twilio_sid || null,
      sent_by: row.sent_by || null,
      keyword: row.keyword || null,
    },
  };
}
