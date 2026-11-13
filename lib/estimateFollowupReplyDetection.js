/* eslint-disable no-undef */
/**
 * estimateFollowupReplyDetection — Gmail inbound-reply detection for the
 * automated estimate follow-up sequence.
 *
 * Built per the explicit "REQUIRED CHANGE" request: the estimate follow-up
 * sequence must automatically detect and react to a customer's reply,
 * without a sales rep manually watching for one.
 *
 * Gmail capability used (NO OAuth scope change — see lib/gmailOAuthRouter.js's
 * SCOPES constant, which already grants BOTH gmail.send and gmail.readonly
 * for this same mailbox; gmail.readonly was added for routes/leadEmails.js
 * and production-verified to actually work for a real Gmail read):
 *   - users.getProfile  — cheap bootstrap: the mailbox's CURRENT historyId,
 *     used only the very first time this ever runs (never scans historical
 *     mail — a reply that arrived before reply detection was first enabled
 *     was never actionable anyway).
 *   - users.history.list — the incremental, checkpointed poll itself
 *     (startHistoryId = the last ID we successfully processed,
 *     historyTypes=messageAdded, labelId=INBOX). Durable checkpoint lives in
 *     estimate_followup_gmail_checkpoint (db/migrations/2026-71), one row
 *     per mailbox, advanced only after a page is fully processed.
 *   - users.messages.get (format=metadata) — just enough headers
 *     (From/To/Subject/Date/Auto-Submitted/Precedence) to classify and
 *     correlate each new message; the response's own top-level `threadId`
 *     is used for correlation regardless of format.
 *
 * Thread correlation (preferred over address-only matching, per the
 * explicit requirement): lib/gmailSender.js's sendEmail() now returns the
 * threadId Gmail organically assigned to each sent message (read back from
 * the send response, never forced via custom References/In-Reply-To —
 * Gmail's documented criteria for grouping an explicitly-set threadId
 * requires the Subject to also match, which the 6 templates' deliberately
 * distinct subjects would break); lib/estimateFollowupEngine.js persists it
 * per-step onto estimate_followup_steps.gmail_thread_id. An inbound
 * message's own threadId (assigned by Gmail from the customer's own
 * In-Reply-To/References — their mail client sets those correctly even
 * though we never set custom headers on send) is compared against every
 * active/paused sequence's sent steps. Only when no thread match exists
 * does this fall back to a From-address match against the sequence's own
 * recorded recipient_email — the SAME "prefer the strong signal, fall back
 * to address, never guess on ambiguity" shape this codebase already uses
 * for SMS (lib/smsService.js's phone-matching). Zero matches = an ordinary,
 * untracked inbound email (ignored, never logged). More than one match
 * (e.g. two sequences impossibly sharing both the same recipient address
 * AND no thread match, or a thread-id collision) is never guessed — it is
 * recorded in estimate_followup_ambiguous_replies for manual staff triage,
 * mirroring this codebase's existing SMS ambiguous-match convention.
 *
 * Bounce/autoresponder/self-loop filtering (`looksLikeAutomatedOrBounce`):
 * a mailer-daemon/postmaster/no-reply From address, an RFC 3834
 * `Auto-Submitted` header that isn't "no", a bulk/junk/list `Precedence`
 * header, a common automated-subject pattern (out-of-office, delivery
 * failure, etc.), or a message From our own sending address are all
 * ignored before any correlation is attempted — never paused a sequence or
 * notified a rep over a bounce or an auto-reply.
 *
 * FAIL-CLOSED SAFETY GATE (`isReplyMonitoringHealthy`) — the literal,
 * strict reading of the explicit requirement: "If the reply-monitoring
 * connection is unhealthy or its checkpoint is stale, fail closed: hold
 * outgoing follow-up emails until reply monitoring is restored." This is
 * checked by lib/estimateFollowupEngine.js#processEstimateFollowups BEFORE
 * sending ANY real email for ANY sequence on a tick — not per-affected-lead,
 * the WHOLE tick holds. Healthy requires ALL of: the feature explicitly
 * enabled (ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED='true' — absence is
 * itself treated as "unhealthy", never "feature simply off" split out from
 * "monitoring is down" — satisfying the fail-closed requirement precisely:
 * a real send is only ever possible when reply detection is actively
 * running AND succeeding), a checkpoint row that has polled successfully
 * recently, and that poll's own tri-state status (healthy/degraded/
 * unhealthy, surfaced to System Health for finer-grained display) reading
 * exactly 'healthy' — 'degraded' is deliberately NOT good enough for the
 * send gate, only for display, since the requirement says "stale" fails
 * closed too and degraded IS the stale state.
 *
 * Reminder worker cron cadence is ~30 minutes (reminderWorker.js's own
 * header comment) — STALE_AFTER_MS/DEGRADED_AFTER_MS are sized off that.
 *
 * Notification on a detected reply (ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED,
 * a SEPARATE gate from reply detection itself — mirrors this codebase's own
 * SMS_AUTOMATED_REMINDERS_ENABLED/SMS_REPLY_NOTIFICATIONS_ENABLED split
 * precedent) is delegated to lib/estimateFollowupReplyNotify.js, EMAIL ONLY
 * per the explicit requirement — never SMS, never a second channel.
 */
'use strict';

const db = require('../db/client');
const gmail = require('./gmailSender');
const replyNotify = require('./estimateFollowupReplyNotify');
const { logFollowupActivity } = require('./estimateFollowupActivityLog');

const MAILBOX = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';

const STALE_AFTER_MS = 90 * 60 * 1000; // 90 min = 3 reminder-worker ticks
const DEGRADED_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours
const FAILURE_THRESHOLD_DEGRADED = 2;
const FAILURE_THRESHOLD_UNHEALTHY = 5;
const MAX_HISTORY_PAGES = 5; // bounded, not unbounded — mirrors routes/leadEmails.js's own MAX_PAGES convention

const BOUNCE_FROM_PATTERNS = [/^mailer-daemon@/i, /^postmaster@/i, /^bounces?@/i, /^no-?reply@/i, /^do-?not-?reply@/i];
const AUTOMATED_SUBJECT_PATTERNS = [
  /^automatic reply/i, /^auto-?reply/i, /^out of office/i, /^undeliverable/i,
  /^delivery status notification/i, /^mail delivery failed/i, /^message blocked/i,
  /^undelivered mail returned to sender/i, /^returned mail/i,
];

function replyDetectionEnabled() {
  return process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED === 'true';
}
function replyNotificationsEnabled() {
  return process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED === 'true';
}

async function gmailFetch(token, path, { query: q } = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  if (q) for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, item); }
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* best-effort */ }
    if (res.status === 401) throw new gmail.GmailCredentialsError(`Gmail read 401: ${String(detail).slice(0, 200)}`);
    const err = new Error(`Gmail read ${res.status}: ${String(detail).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  try { return await res.json(); } catch { return {}; }
}

function headerValue(payload, name) {
  const headers = (payload && payload.headers) || [];
  const found = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function extractEmailAddress(headerVal) {
  if (!headerVal) return '';
  const m = String(headerVal).match(/<([^>]+)>/);
  return (m ? m[1] : String(headerVal)).trim();
}

function looksLikeAutomatedOrBounce({ from, subject, autoSubmitted, precedence }) {
  const fromAddr = extractEmailAddress(from).toLowerCase();
  if (!fromAddr) return true;
  if (fromAddr === MAILBOX.toLowerCase()) return true; // self-loop
  if (BOUNCE_FROM_PATTERNS.some((re) => re.test(fromAddr))) return true;
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;
  if (precedence && /^(bulk|junk|list)$/i.test(precedence.trim())) return true;
  if (AUTOMATED_SUBJECT_PATTERNS.some((re) => re.test((subject || '').trim()))) return true;
  return false;
}

async function getCheckpointRow() {
  const { rows } = await db.query(`SELECT * FROM estimate_followup_gmail_checkpoint WHERE mailbox = $1`, [MAILBOX]);
  return rows[0] || null;
}

async function ensureCheckpointRow() {
  const existing = await getCheckpointRow();
  if (existing) return existing;
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, status) VALUES ($1, 'unhealthy') ON CONFLICT (mailbox) DO NOTHING`,
    [MAILBOX]
  );
  return getCheckpointRow();
}

function computeStatus(row) {
  if (!row || !row.last_success_at) return 'unhealthy';
  const ageMs = Date.now() - new Date(row.last_success_at).getTime();
  const failures = row.consecutive_failures || 0;
  if (ageMs > DEGRADED_AFTER_MS || failures >= FAILURE_THRESHOLD_UNHEALTHY) return 'unhealthy';
  if (ageMs > STALE_AFTER_MS || failures >= FAILURE_THRESHOLD_DEGRADED) return 'degraded';
  return 'healthy';
}

/**
 * The fail-closed gate every real estimate-followup send must pass before
 * this codebase will send a single customer email. See the module header
 * for the exact semantics of each failure reason.
 */
async function isReplyMonitoringHealthy() {
  if (!replyDetectionEnabled()) {
    return { healthy: false, reason: 'reply_detection_disabled' };
  }
  const row = await getCheckpointRow();
  if (!row) return { healthy: false, reason: 'no_checkpoint' };
  const status = computeStatus(row);
  if (status !== 'healthy') {
    return { healthy: false, reason: `checkpoint_${status}`, status, lastSuccessAt: row.last_success_at, consecutiveFailures: row.consecutive_failures };
  }
  return { healthy: true, reason: 'ok', status, lastSuccessAt: row.last_success_at };
}

async function recordFailure(checkpoint, errMsg) {
  const failures = ((checkpoint && checkpoint.consecutive_failures) || 0) + 1;
  const status = failures >= FAILURE_THRESHOLD_UNHEALTHY ? 'unhealthy'
    : (failures >= FAILURE_THRESHOLD_DEGRADED ? 'degraded' : ((checkpoint && checkpoint.status) || 'unhealthy'));
  try {
    await db.query(
      `UPDATE estimate_followup_gmail_checkpoint SET consecutive_failures=$2, status=$3, last_checked_at=NOW(), last_error=$4 WHERE mailbox=$1`,
      [MAILBOX, failures, status, String(errMsg).slice(0, 500)]
    );
  } catch (e) { console.warn('[estimate-followup-reply] failed to record poll failure:', e.message); }
}

async function recordAmbiguousReply({ messageId, threadId, fromAddr, sequenceIds, reason, receivedAt }) {
  try {
    const receivedIso = receivedAt && !Number.isNaN(new Date(receivedAt).getTime()) ? new Date(receivedAt).toISOString() : null;
    await db.query(
      `INSERT INTO estimate_followup_ambiguous_replies (gmail_message_id, gmail_thread_id, from_address, candidate_sequence_ids, reason, received_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (gmail_message_id) DO NOTHING`,
      [messageId, threadId || null, fromAddr, JSON.stringify(sequenceIds), reason, receivedIso]
    );
  } catch (e) { console.warn('[estimate-followup-reply] failed to record ambiguous reply:', e.message); }
}

/**
 * First-ever poll for this mailbox: there is no "start of time" Gmail will
 * accept, so this bootstraps from the mailbox's CURRENT historyId — a reply
 * sent before reply detection was first enabled was never actionable
 * anyway (the follow-up sequence itself only exists going forward).
 */
async function bootstrapHistoryId(token) {
  const profile = await gmailFetch(token, 'profile');
  return profile.historyId;
}

/**
 * Correlate one new inbound message to at most one active/paused sequence,
 * permanently stop it (never merely pause — see the 'stopped' transition
 * below), log the activity, and notify. Never throws — callers treat a
 * per-message failure as best-effort (see pollForReplies's own catch around
 * each call).
 */
async function processInboundMessage(token, messageId, results) {
  const msg = await gmailFetch(token, `messages/${messageId}`, {
    query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Auto-Submitted', 'Precedence'] },
  });
  const payload = msg.payload || {};
  const from = headerValue(payload, 'From');
  const subject = headerValue(payload, 'Subject') || '(no subject)';
  const autoSubmitted = headerValue(payload, 'Auto-Submitted');
  const precedence = headerValue(payload, 'Precedence');
  const dateHeader = headerValue(payload, 'Date');
  const threadId = msg.threadId;

  if (looksLikeAutomatedOrBounce({ from, subject, autoSubmitted, precedence })) {
    results.ignored++;
    return;
  }

  const fromAddr = extractEmailAddress(from).toLowerCase();

  // 1. Thread-id correlation — preferred, per the explicit requirement.
  // Deliberately NOT restricted to active/paused: since a genuine reply now
  // permanently STOPS its sequence (see below), a thread-id match against an
  // already-stopped/completed sequence must still correlate — otherwise a
  // redelivered copy of the SAME message that triggered the stop (Intuit-
  // style at-least-once delivery, which Gmail's own history.list shares no
  // stronger guarantee against) would fall through to "zero matches", lose
  // its idempotency attribution, and risk being misread as a genuinely
  // unrelated, untracked email. Only the actual STOP transition itself (the
  // UPDATE below) stays scoped to active/paused — stopping an already-
  // terminal sequence a second time is already a correctly-handled no-op.
  const { rows: threadMatches } = await db.query(
    `SELECT DISTINCT seq.id FROM estimate_followup_sequences seq
       JOIN estimate_followup_steps st ON st.sequence_id = seq.id
      WHERE st.gmail_thread_id = $1 AND st.status = 'sent'`,
    [threadId]
  );
  let sequenceIds = threadMatches.map((r) => r.id);
  let matchMethod = 'thread_id';

  if (sequenceIds.length === 0) {
    // 2. Fallback: From-address match against the sequence's own recorded
    //    recipient — never a lead-table-wide scan, never the From header's
    //    display name.
    const { rows: addrMatches } = await db.query(
      `SELECT id FROM estimate_followup_sequences WHERE status IN ('active','paused') AND LOWER(recipient_email) = $1`,
      [fromAddr]
    );
    sequenceIds = addrMatches.map((r) => r.id);
    matchMethod = 'from_address';
  }

  if (sequenceIds.length === 0) {
    // An ordinary, untracked inbound email — never logged as ambiguous
    // (every untracked message would otherwise flood that table).
    results.ignored++;
    return;
  }

  if (sequenceIds.length > 1) {
    await recordAmbiguousReply({ messageId, threadId, fromAddr, sequenceIds, reason: `multiple_${matchMethod}_matches`, receivedAt: dateHeader });
    results.ambiguous++;
    return;
  }

  const sequenceId = sequenceIds[0];
  const messageDate = dateHeader && !Number.isNaN(new Date(dateHeader).getTime()) ? new Date(dateHeader).toISOString() : new Date().toISOString();

  // Idempotent on external_ref (activities' pre-existing table-wide UNIQUE
  // index) — a redelivered/duplicate history entry for the same Gmail
  // message never creates a second activity row or double-pauses/notifies.
  const inserted = await db.query(
    `INSERT INTO activities (lead_id, type, content, author, source, metadata, external_ref, created_at)
       SELECT lead_id, 'email', $2, $3, 'gmail', $4::jsonb, $5, $6
         FROM estimate_followup_sequences WHERE id = $1
     ON CONFLICT (external_ref) DO NOTHING RETURNING id`,
    [
      sequenceId, subject, from,
      JSON.stringify({ direction: 'inbound', from, gmail_message_id: messageId, gmail_thread_id: threadId, estimate_followup_sequence_id: sequenceId, match_method: matchMethod }),
      `estimate-followup-reply:${messageId}`, messageDate,
    ]
  );
  const isNewReply = inserted.rows.length > 0;

  // November 2026 — "the CRM immediately stops or permanently cancels all
  // remaining estimate follow-up emails... do not require a team member to
  // stop the sequence manually". A genuine reply now moves the sequence
  // straight to the TERMINAL 'stopped' state (never 'paused', which a human
  // could leave un-resumed but which is still, by design, resumable) and
  // cancels any step still 'pending'/'processing' in the same transaction —
  // mirroring stopSequence()'s own two-query shape exactly (duplicated
  // rather than imported, to avoid a circular require between this module
  // and estimateFollowupEngine.js, which already requires this one).
  const { rows: stoppedRows } = await db.query(
    `UPDATE estimate_followup_sequences
        SET status='stopped', stopped_reason='customer_replied', stopped_at=NOW(),
            stopped_by='system:gmail_reply_detected', triggering_gmail_message_id=$2
      WHERE id=$1 AND status IN ('active','paused') RETURNING *`,
    [sequenceId, messageId]
  );
  if (stoppedRows.length > 0) {
    await db.query(
      `UPDATE estimate_followup_steps SET status='cancelled' WHERE sequence_id=$1 AND status IN ('pending','processing')`,
      [sequenceId]
    );
    // A SECOND, dedicated note alongside the raw inbound-email activity row
    // inserted above — explicit requirement: "the lead's activity history
    // records the reply AND the automatic stop, including timestamp and
    // reason" as its own legible fact, not something a reader has to infer
    // from the inbound email's metadata JSON.
    await logFollowupActivity(
      stoppedRows[0].lead_id,
      `Estimate follow-up automatically stopped — customer replied to a follow-up email (from ${fromAddr}). No further automated follow-up emails will be sent.`,
      { author: 'system:gmail_reply_detected' }
    );
  }

  results.matched++;

  if (isNewReply && stoppedRows.length > 0) {
    try {
      await replyNotify.notifyReplyDetected({ sequence: stoppedRows[0], fromAddr, subject, messageId });
    } catch (e) {
      console.warn('[estimate-followup-reply] notify failed (non-fatal):', e.message);
    }
  }
}

/**
 * Per-tick entry point (reminderWorker.js). Never throws — always returns a
 * result object; a failure is recorded onto the durable checkpoint (which
 * feeds isReplyMonitoringHealthy's fail-closed gate) rather than crashing
 * the worker tick.
 */
async function pollForReplies({ triggeredBy = 'cron' } = {}) {
  if (!replyDetectionEnabled()) {
    return { ok: true, skipped: true, reason: 'disabled', triggeredBy };
  }
  const checkpoint = await ensureCheckpointRow();
  try {
    const token = await gmail.refreshAccessToken();

    if (!checkpoint.history_id) {
      const historyId = await bootstrapHistoryId(token);
      await db.query(
        `UPDATE estimate_followup_gmail_checkpoint SET history_id=$2, status='healthy', consecutive_failures=0, last_checked_at=NOW(), last_success_at=NOW(), last_error=NULL WHERE mailbox=$1`,
        [MAILBOX, historyId]
      );
      return { ok: true, bootstrapped: true, historyId, triggeredBy };
    }

    const messageIds = new Set();
    let pageToken;
    let pages = 0;
    let newHistoryId = checkpoint.history_id;
    let historyGone = false;
    do {
      let page;
      try {
        page = await gmailFetch(token, 'history', {
          query: {
            startHistoryId: newHistoryId,
            historyTypes: 'messageAdded',
            labelId: 'INBOX',
            ...(pageToken ? { pageToken } : {}),
          },
        });
      } catch (e) {
        // Gmail returns 404 once startHistoryId ages out of its retention
        // window — the checkpoint is unrecoverable at that point. Never
        // crash the poll: re-bootstrap from the CURRENT historyId (same as
        // a fresh install) and record the gap as a visible, non-fatal
        // 'degraded' event rather than losing the checkpoint silently.
        if (e.status === 404) { historyGone = true; break; }
        throw e;
      }
      for (const h of (page.history || [])) {
        for (const added of (h.messagesAdded || [])) {
          if (added.message && added.message.id) messageIds.add(added.message.id);
        }
      }
      if (page.historyId) newHistoryId = page.historyId;
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_HISTORY_PAGES);

    if (historyGone) {
      const freshHistoryId = await bootstrapHistoryId(token);
      await db.query(
        `UPDATE estimate_followup_gmail_checkpoint SET history_id=$2, status='degraded', consecutive_failures=0, last_checked_at=NOW(), last_success_at=NOW(), last_error=$3 WHERE mailbox=$1`,
        [MAILBOX, freshHistoryId, 'history_checkpoint_expired_resynced']
      );
      return { ok: true, resynced: true, historyId: freshHistoryId, triggeredBy };
    }

    const results = { messagesSeen: messageIds.size, matched: 0, ambiguous: 0, ignored: 0 };
    for (const id of messageIds) {
      try {
        await processInboundMessage(token, id, results);
      } catch (perMsgErr) {
        console.warn('[estimate-followup-reply] per-message processing failed (best-effort):', perMsgErr.message);
      }
    }

    await db.query(
      `UPDATE estimate_followup_gmail_checkpoint SET history_id=$2, status='healthy', consecutive_failures=0, last_checked_at=NOW(), last_success_at=NOW(), last_error=NULL WHERE mailbox=$1`,
      [MAILBOX, newHistoryId]
    );
    return { ok: true, ...results, historyId: newHistoryId, triggeredBy };
  } catch (e) {
    await recordFailure(checkpoint, e.message);
    return { ok: false, error: e.message, triggeredBy };
  }
}

/** Read-only status for System Health / the admin overview panel. */
async function getReplyMonitoringStatus() {
  const row = await getCheckpointRow();
  const health = await isReplyMonitoringHealthy();
  let unresolvedAmbiguous = null;
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM estimate_followup_ambiguous_replies WHERE NOT resolved`);
    unresolvedAmbiguous = rows[0].n;
  } catch { /* best-effort — never fail the whole status read over this */ }
  return {
    enabled: replyDetectionEnabled(),
    notifications_enabled: replyNotificationsEnabled(),
    mailbox: MAILBOX,
    checkpoint: row ? {
      status: computeStatus(row),
      history_id: row.history_id,
      consecutive_failures: row.consecutive_failures,
      last_checked_at: row.last_checked_at,
      last_success_at: row.last_success_at,
      last_error: row.last_error,
    } : null,
    healthy_for_sending: health.healthy,
    reason: health.reason,
    unresolved_ambiguous_replies: unresolvedAmbiguous,
  };
}

module.exports = {
  MAILBOX,
  STALE_AFTER_MS,
  DEGRADED_AFTER_MS,
  replyDetectionEnabled,
  replyNotificationsEnabled,
  looksLikeAutomatedOrBounce,
  extractEmailAddress,
  computeStatus,
  isReplyMonitoringHealthy,
  pollForReplies,
  getReplyMonitoringStatus,
  getCheckpointRow,
};
