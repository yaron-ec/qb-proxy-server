/**
 * idempotencyKeys — PURE, deterministic idempotency-key builders for email.
 *
 * No timestamps, no RNG, no unstable UI values. The same logical action always
 * produces the same key, so retries
 * and overlapping calls deduplicate against the server's idempotency claim
 * (email_send_claims UNIQUE idempotency_key, reminder_claims UNIQUE
 * reminder_key).
 *
 * ESM (.mjs) so it is importable by both the Vite frontend
 * (src/lib/emailTransport.js) and Node test harnesses
 * (src/proxy-server/test/idempotencyKeys.test.js via dynamic import).
 *
 * Key shapes (stable):
 *   generic:           crm-email:{leadId}:{recipient}:{clientRequestId}
 *   invoice:           invoice-email:{invoiceId}:{recipient}:{version}
 *   manualReminder:    manual-reminder:{leadId}:{recipient}:{reminderType}:{scheduledStart}
 *   scheduledReminder: scheduled-reminder:{leadId}:{recipient}:{window}:{scheduledStart}
 *   test:              test-email:{recipient}:{nonce}  (nonce caller-supplied, new per deliberate test)
 */

const s = (v) => String(v == null ? '' : v);

export const IdempotencyKeys = {
  generic: (leadId, recipient, clientRequestId) =>
    `crm-email:${s(leadId) || 'nolead'}:${s(recipient) || 'norecipient'}:${s(clientRequestId)}`,
  invoice: (invoiceId, recipient, version) =>
    `invoice-email:${s(invoiceId)}:${s(recipient)}:${s(version) || 'noversion'}`,
  manualReminder: (leadId, recipient, reminderType, scheduledStart) =>
    `manual-reminder:${s(leadId)}:${s(recipient)}:${s(reminderType) || 'manual'}:${s(scheduledStart)}`,
  scheduledReminder: (leadId, recipient, window, scheduledStart) =>
    `scheduled-reminder:${s(leadId)}:${s(recipient)}:${s(window)}:${s(scheduledStart)}`,
  test: (recipient, nonce) => `test-email:${s(recipient)}:${s(nonce)}`,
};

export default IdempotencyKeys;