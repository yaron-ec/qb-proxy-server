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
    [leadId, from || '', toE164, body, result.sid, result.status, result.errorCode, result.errorMessage, sentBy || null]
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

/** Apply a Twilio status-callback update to the matching outbound row (by MessageSid). Never throws if the row isn't found (an out-of-order/duplicate callback is not an error). */
async function handleStatusCallback({ messageSid, status, errorCode, errorMessage }) {
  const r = await query(
    `UPDATE sms_messages SET status = $1, error_code = $2, error_message = $3, updated_at = NOW()
     WHERE twilio_sid = $4 RETURNING *`,
    [status, errorCode || null, errorMessage || null, messageSid]
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
};
