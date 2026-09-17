/**
 * railway emails — the ONE real, working outbound email path.
 *
 *   send({ to, cc, replyTo, subject, htmlBody, idempotencyKey }) -> { ok, gmailMessageId, ... }
 *
 * Hits POST /api/v1/emails/send (routes/emails.js), which sends through the
 * single connected company Gmail account (lib/gmailSender.js — see
 * CLAUDE.md: "single hardcoded mailbox," not genuinely multi-account). The
 * sender address is fixed server-side; this client never supplies one.
 */
import { apiCall } from './client';

export function send({ to, cc, replyTo, subject, htmlBody, idempotencyKey, metadata }) {
  return apiCall('/api/v1/emails/send', {
    method: 'POST',
    body: { to, cc, replyTo, subject, htmlBody, idempotencyKey, metadata },
  });
}
