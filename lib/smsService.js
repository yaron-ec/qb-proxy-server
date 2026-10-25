/* eslint-disable no-undef */
/**
 * smsService — the ONE place that decides whether an SMS is allowed to go
 * out, matches an inbound message to a lead, and persists the two-way log
 * (sms_messages / sms_opt_outs — see db/migrations/2026-63-sms-messaging.sql).
 * lib/smsClient.js only talks to Twilio; every policy decision lives here.
 *
 * ── Consent model (this phase) ──────────────────────────────────────────
 * Every outbound SMS built here is transactional/service messaging (a reply
 * to a customer, an appointment/follow-up notice) — never marketing. It is
 * gated on the SAME leads.sms_consent column migration 2026-43 already
 * added (no new consent column in this phase — see 2026-63's own header for
 * why). A lead with sms_consent is not true/false explicit is treated as NOT
 * consented — existing phone-number presence alone NEVER implies consent.
 *
 * ── Opt-out (STOP/START/HELP) ────────────────────────────────────────────
 * sms_opt_outs is keyed by PHONE NUMBER, not lead — a STOP must be honored
 * for that number forever, independent of which lead (if any) it is ever
 * matched to. Checked on every outbound send, unconditionally, before
 * sms_consent is even considered — an opted-out number is never messaged
 * regardless of consent. Twilio's own Advanced Opt-Out (if enabled on the
 * Messaging Service) is a second, independent layer; this one never assumes
 * that layer is configured.
 *
 * ── Phone matching ───────────────────────────────────────────────────────
 * Inbound numbers are matched against leads.phone using
 * lib/captureValidation.js#normalizePhone (bare last-10-digits) — the SAME
 * tolerant comparison already used by the public-capture/booking intake path
 * (see CLAUDE.md's documented phone-matching split: the admin path uses
 * exact +1XXXXXXXXXX, the capture-style path uses bare-last-10). An inbound
 * webhook is exactly the capture-style case (an external, unauthenticated
 * phone number with no guarantee of formatting), so that is the one reused
 * here — never a third implementation. Zero or multiple matching leads is
 * never resolved by guessing: zero → lead_id NULL; multiple → lead_id NULL,
 * ambiguous_match=true, candidate_lead_ids populated for manual review.
 *
 * ── Quiet hours ──────────────────────────────────────────────────────────
 * Outbound sends are blocked outside QUIET_HOURS_START..QUIET_HOURS_END in
 * the installation's configured timezone (lib/companyConfig.js#getTimezone,
 * default America/Los_Angeles) — default window 8:00–21:00, configurable via
 * env vars. STOP/START/HELP replies are never gated by quiet hours (this
 * module only enforces quiet hours on the OUTBOUND send path; inbound
 * keyword processing always runs).
 */
'use strict';

const { query } = require('../db/client');
const smsClient = require('./smsClient');
const { normalizePhone } = require('./captureValidation');

/**
 * The exact Twilio Message-resource statuses this integration can
 * legitimately receive (plain, two-way, single-recipient SMS/MMS, sent via
 * either a Messaging Service or a bare From number — no Schedule Send, no
 * WhatsApp/channels) — MUST stay in sync with
 * db/migrations/2026-65-sms-messages-status-check-widen.sql's
 * sms_messages_status_check allow-list (see that migration's header for why
 * each value is/isn't included; test/smsService.test.js asserts this array
 * matches the live constraint against a real Postgres instance).
 */
const KNOWN_SMS_STATUSES = new Set([
  'accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered',
  'failed', 'canceled', 'receiving', 'received',
]);

/**
 * Defense in depth beyond the DB constraint: if Twilio ever reports a status
 * this integration hasn't seen before (a new value Twilio adds, or a
 * channel/feature this installation doesn't use), never let a raw INSERT/
 * UPDATE hit the CHECK constraint again — log it for investigation and fall
 * back to a safe, already-allowed value instead. `fallback` is the status to
 * use if `status` isn't recognized.
 */
function normalizeSmsStatus(status, fallback) {
  if (KNOWN_SMS_STATUSES.has(status)) return status;
  console.warn(`[smsService] unrecognized Twilio status "${status}" — falling back to "${fallback}". Investigate: Twilio may have introduced a new status value.`);
  return fallback;
}

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

const QUIET_HOURS_START = parseInt(process.env.SMS_QUIET_HOURS_START || '8', 10);
const QUIET_HOURS_END = parseInt(process.env.SMS_QUIET_HOURS_END || '21', 10);

/** 'STOP' | 'START' | 'HELP' | null — exact match on the trimmed, uppercased body (Twilio's own convention: a keyword match is the WHOLE message, never a substring). */
function detectKeyword(body) {
  const normalized = String(body || '').trim().toUpperCase();
  if (STOP_KEYWORDS.has(normalized)) return 'STOP';
  if (START_KEYWORDS.has(normalized)) return 'START';
  if (HELP_KEYWORDS.has(normalized)) return 'HELP';
  return null;
}

/** Is `now` (a Date) outside the allowed send window in the given IANA timezone? */
function isQuietHours(now, timezone) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now),
    10
  );
  // hour can come back as 24 for midnight in some ICU implementations.
  const h = hour === 24 ? 0 : hour;
  return h < QUIET_HOURS_START || h >= QUIET_HOURS_END;
}

async function isOptedOut(phoneNormalized) {
  const r = await query('SELECT opted_out FROM sms_opt_outs WHERE phone_number = $1', [phoneNormalized]);
  return !!(r.rows[0] && r.rows[0].opted_out);
}

async function recordOptOut(phoneNormalized, keyword) {
  await query(
    `INSERT INTO sms_opt_outs (phone_number, opted_out, opted_out_at, last_keyword, source)
     VALUES ($1, true, NOW(), $2, 'customer_reply')
     ON CONFLICT (phone_number) DO UPDATE SET opted_out = true, opted_out_at = NOW(), last_keyword = $2, updated_at = NOW()`,
    [phoneNormalized, keyword]
  );
}

async function recordOptIn(phoneNormalized, keyword) {
  await query(
    `INSERT INTO sms_opt_outs (phone_number, opted_out, opted_in_at, last_keyword, source)
     VALUES ($1, false, NOW(), $2, 'customer_reply')
     ON CONFLICT (phone_number) DO UPDATE SET opted_out = false, opted_in_at = NOW(), last_keyword = $2, updated_at = NOW()`,
    [phoneNormalized, keyword]
  );
}

/**
 * Resolve the lead(s) matching an inbound phone number.
 * Returns { leadId, ambiguous, candidateIds }. Zero matches: leadId=null,
 * ambiguous=false. Exactly one: leadId set. Two+: leadId=null,
 * ambiguous=true, candidateIds populated — never guessed.
 */
async function matchLeadByPhone(rawPhone) {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return { leadId: null, ambiguous: false, candidateIds: [] };
  const { rows } = await query(
    `SELECT id FROM leads WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1`,
    [normalized]
  );
  if (rows.length === 0) return { leadId: null, ambiguous: false, candidateIds: [] };
  if (rows.length === 1) return { leadId: rows[0].id, ambiguous: false, candidateIds: [] };
  return { leadId: null, ambiguous: true, candidateIds: rows.map((r) => r.id) };
}

class SmsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Send an outbound SMS on behalf of a lead (Lead Detail "Send" action, or a
 * future automated reminder). Enforces, in order: opt-out (fail closed,
 * unconditional), consent (leads.sms_consent must be exactly true), quiet
 * hours. Persists the sms_messages row regardless of outcome (a rejected
 * send is still worth a record for the rep to see why nothing went out).
 */
async function sendSms({ leadId, body, sentBy, statusCallbackUrl, now }) {
  const nowDate = now || new Date();
  const leadRow = (await query('SELECT id, phone, sms_consent FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!leadRow) throw new SmsError('lead_not_found', 'Lead not found');
  if (!leadRow.phone) throw new SmsError('no_phone', 'Lead has no phone number on file');
  const toNormalized = normalizePhone(leadRow.phone);
  if (!toNormalized) throw new SmsError('invalid_phone', 'Lead phone number is not a valid 10-digit US number');

  if (await isOptedOut(toNormalized)) {
    throw new SmsError('recipient_opted_out', 'This phone number has opted out of SMS (STOP) and cannot be messaged');
  }
  if (leadRow.sms_consent !== true) {
    throw new SmsError('no_consent', 'This lead has not given SMS consent');
  }
  const timezone = await require('./companyConfig').getTimezone();
  if (isQuietHours(nowDate, timezone)) {
    throw new SmsError('quiet_hours', `Outbound SMS is restricted to ${QUIET_HOURS_START}:00–${QUIET_HOURS_END}:00 (${timezone})`);
  }

  const { from } = smsClient.getCredentials();
  const toE164 = `+1${toNormalized}`;
  let result;
  try {
    result = await smsClient.sendMessage({ to: toE164, body, statusCallbackUrl });
  } catch (e) {
    // Transport failure (network/config) — one bounded immediate retry, same
    // "bounded retry for transient failure" philosophy as qbTokenManager.
    if (e.code === 'twilio_not_configured') throw new SmsError('twilio_not_configured', e.message);
    try {
      result = await smsClient.sendMessage({ to: toE164, body, statusCallbackUrl });
    } catch (e2) {
      const ins = await query(
        `INSERT INTO sms_messages (lead_id, direction, from_number, to_number, body, status, error_message, sent_by)
         VALUES ($1, 'outbound', $2, $3, $4, 'failed', $5, $6) RETURNING *`,
        [leadId, from || '', toE164, body, e2.message, sentBy || null]
      );
      throw Object.assign(new SmsError('send_failed', e2.message), { messageRow: ins.rows[0] });
    }
  }

  const row = (await query(
    `INSERT INTO sms_messages (lead_id, direction, from_number, to_number, body, twilio_sid, status, error_code, error_message, sent_by)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (twilio_sid) DO NOTHING RETURNING *`,
    [leadId, from || '', toE164, body, result.sid, normalizeSmsStatus(result.status, 'queued'), result.errorCode, result.errorMessage, sentBy || null]
  )).rows[0];
  if (!result.ok) throw Object.assign(new SmsError('twilio_rejected', result.errorMessage || 'Twilio rejected the message'), { messageRow: row });
  return row;
}

/**
 * Process one inbound Twilio message webhook payload. Always persists a row
 * (even an unmatched/ambiguous one — never silently dropped). STOP/START/HELP
 * is detected and recorded BEFORE lead matching, and always processed
 * regardless of whether a lead match exists, since opt-out is phone-level.
 * Idempotent on Twilio's MessageSid: a redelivered webhook never creates a
 * second row or double-processes a keyword.
 */
async function handleInboundMessage({ messageSid, from, to, body }) {
  const existing = await query('SELECT * FROM sms_messages WHERE twilio_sid = $1', [messageSid]);
  if (existing.rows[0]) return { duplicate: true, row: existing.rows[0] };

  const normalizedFrom = normalizePhone(from);
  const keyword = detectKeyword(body);
  if (keyword === 'STOP' && normalizedFrom) await recordOptOut(normalizedFrom, keyword);
  else if (keyword === 'START' && normalizedFrom) await recordOptIn(normalizedFrom, keyword);
  // HELP is recorded on the message row only — no state change — the reply
  // (business name + support contact) is sent by the webhook route, not here.

  const match = await matchLeadByPhone(from);
  const row = (await query(
    `INSERT INTO sms_messages (lead_id, direction, from_number, to_number, body, twilio_sid, status, ambiguous_match, candidate_lead_ids, keyword)
     VALUES ($1, 'inbound', $2, $3, $4, $5, 'received', $6, $7, $8)
     ON CONFLICT (twilio_sid) DO NOTHING RETURNING *`,
    [match.leadId, from, to, body, messageSid, match.ambiguous, match.ambiguous ? match.candidateIds : null, keyword]
  )).rows[0];
  return { duplicate: false, row, match, keyword };
}

/**
 * Apply a Twilio status-callback update to the matching outbound row (by
 * MessageSid). Never throws if the row isn't found (an out-of-order/
 * duplicate callback is not an error). An unrecognized status (see
 * normalizeSmsStatus) never overwrites the row's last-known-good status —
 * there's no safe "fallback" value to guess here, unlike a brand-new send,
 * so the error fields still update (a rep should still see the error code/
 * message Twilio sent) but the status column is left as whatever it already
 * was.
 */
async function handleStatusCallback({ messageSid, status, errorCode, errorMessage }) {
  const statusToWrite = KNOWN_SMS_STATUSES.has(status) ? status : null;
  if (!statusToWrite) {
    console.warn(`[smsService] unrecognized Twilio status "${status}" on status-callback for ${messageSid} — leaving the row's existing status unchanged. Investigate: Twilio may have introduced a new status value.`);
  }
  const r = await query(
    `UPDATE sms_messages SET status = COALESCE($1, status), error_code = $2, error_message = $3, updated_at = NOW()
     WHERE twilio_sid = $4 RETURNING *`,
    [statusToWrite, errorCode || null, errorMessage || null, messageSid]
  );
  return r.rows[0] || null;
}

async function getConversation(leadId, limit) {
  const r = await query(
    'SELECT * FROM sms_messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT $2',
    [leadId, limit || 500]
  );
  return r.rows;
}

/**
 * Best-effort durable record of a signature-rejected Twilio webhook attempt
 * (see db/migrations/2026-66-sms-webhook-rejections.sql's header for why
 * this exists — the October 2026 inbound-SMS incident). Never throws: a
 * failure to RECORD a rejection must never mask or replace the 401 response
 * itself, which routes/sms.js sends regardless of whether this succeeds.
 */
async function recordWebhookRejection({ path, computedUrl, hostHeader, hasSignatureHeader, messageSid, fromNumber }) {
  try {
    await query(
      `INSERT INTO sms_webhook_rejections (path, computed_url, host_header, has_signature_header, message_sid, from_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [path, computedUrl || null, hostHeader || null, !!hasSignatureHeader, messageSid || null, fromNumber || null]
    );
  } catch (e) {
    console.error('[smsService] failed to record webhook rejection (non-fatal):', e.message);
  }
}

/**
 * Inbound-delivery evidence for System Health (lib/systemHealthChecks.js#checkTwilio)
 * — mirrors lib/systemHealthChecks.js#checkWebsiteIntake's established
 * "recency + rejection" pattern for an inbound-webhook-only integration: the
 * real evidence of whether inbound SMS has EVER actually worked, completely
 * independent of outbound-send capability.
 */
async function getInboundWebhookHealth() {
  const [received, rejections] = await Promise.all([
    query(`SELECT MAX(created_at) AS last_at, COUNT(*)::int AS total FROM sms_messages WHERE direction = 'inbound'`),
    query(
      `SELECT COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours')::int AS recent_24h,
              COUNT(*)::int AS total, MAX(received_at) AS last_at
       FROM sms_webhook_rejections`
    ),
  ]);
  return {
    recency: { last_lead_received_at: received.rows[0]?.last_at || null, total_leads_received: received.rows[0]?.total || 0 },
    delivery_failures: {
      recent_24h: rejections.rows[0]?.recent_24h || 0,
      total: rejections.rows[0]?.total || 0,
      last_rejected_at: rejections.rows[0]?.last_at || null,
    },
  };
}

module.exports = {
  SmsError,
  detectKeyword,
  isQuietHours,
  isOptedOut,
  recordOptOut,
  recordOptIn,
  matchLeadByPhone,
  sendSms,
  handleInboundMessage,
  handleStatusCallback,
  getConversation,
  QUIET_HOURS_START,
  QUIET_HOURS_END,
  KNOWN_SMS_STATUSES,
  normalizeSmsStatus,
  recordWebhookRejection,
  getInboundWebhookHealth,
};
