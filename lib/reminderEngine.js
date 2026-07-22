/* eslint-disable no-undef */
/**
 * Reminder engine — the core of the Railway reminder system.
 *
 * Execution model: Railway Cron invokes this (via reminderWorker.js or
 * POST /reminders/process) on a single-replica dedicated worker service.
 * Concurrency safety does NOT rely on single-replica topology alone —
 * every reminder is individually claimed atomically in PostgreSQL
 * (UNIQUE reminder_key + INSERT ... ON CONFLICT DO NOTHING, and a
 * conditional lease-takeover UPDATE ... RETURNING), so even overlapping
 * ticks or a crashed run cannot produce a duplicate send.
 *
 * Order of operations per reminder (critical for duplicate prevention):
 *   1. Atomically acquire the Postgres claim (status -> processing).
 *   2. Send all required emails via Gmail.
 *   3. Store accepted Gmail message ids in Postgres.
 *   4. Mark the Postgres claim sent.
 *   5. Write the legacy REMINDER_SENT Activity to Base44 (best-effort,
 *      queued for retry on failure). This is for CRM visibility ONLY and
 *      is never the send gate.
 *
 * Phase 2 status: REMINDER_DRY_RUN defaults to 'true'. In dry-run the
 * engine computes and logs eligible reminders but makes NO Postgres
 * claim writes and sends NO emails. The Base44 production automation is
 * untouched and remains the active sender.
 */
'use strict';

const os = require('os');
const db = require('../db/client');
const time = require('./reminderTime');
const emails = require('./reminderEmails');
const gmail = require('./gmailSender');
const crmRepository = require('./crmRepository');
const health = require('./reminderHealth');
const alerts = require('./reminderAlerts');

const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const COMPANY_NAME = 'EC Construction Group';

// notifyStaff: true = rep + Michelle + Yaron get this window; false = customer only.
// Catch-up windows always notify staff regardless of notifyStaff.
const REMINDER_WINDOWS = [
  { key: '48h', minutesBefore: 48 * 60, notifyStaff: false },
  { key: '24h', minutesBefore: 24 * 60, notifyStaff: false },
  { key: '12h', minutesBefore: 12 * 60, notifyStaff: false },
  { key: '2h', minutesBefore: 2 * 60, notifyStaff: true },
  { key: '30min', minutesBefore: 30, notifyStaff: true },
];

function windowLabel(key) {
  return { '48h': '48 hours', '24h': '24 hours', '12h': '12 hours', '2h': '2 hours', '30min': '30 minutes' }[key] || key;
}

function reminderKey(leadId, windowKey, date) {
  return `reminder:${leadId}:${windowKey}:${date}`;
}

function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const first = ownerName.trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@ecconstructiongroup.com` : null;
}

function getAppointmentMs(lead) {
  const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
  const date = hasFollowUp ? lead.follow_up_date : lead.appointment_date;
  const rawTime = hasFollowUp ? (lead.follow_up_time || '09:00') : (lead.appointment_time || '09:00');
  const type = hasFollowUp ? lead.follow_up_type : 'Meeting';
  if (!date) return null;
  const utcMs = time.pacificToUtcMs(date, rawTime);
  return { ms: utcMs, date, time: rawTime, type };
}

/**
 * Catch-up: if a lead was created within the last 24h and the appointment is
 * still in the future, fire the earliest window whose target time has passed
 * and hasn't been claimed yet. Mirrors the Base44 determineCatchUpWindow.
 * (sentKeys is empty here — the Postgres claim gate is the real dedupe;
 * an already-sent window simply fails to claim and is skipped.)
 */
function determineCatchUpWindow(apptMs, leadCreatedMs, now) {
  const twentyFourHourMs = 24 * 60 * 60 * 1000;
  if (now - leadCreatedMs > twentyFourHourMs) return null;
  if (apptMs <= now) return null;
  for (const win of REMINDER_WINDOWS) {
    const targetMs = apptMs - win.minutesBefore * 60 * 1000;
    if (targetMs <= now) return { ...win, isCatchUp: true };
  }
  return null;
}

function computeWindowsForLead(appt, leadCreatedMs, now) {
  const wins = [];
  for (const win of REMINDER_WINDOWS) {
    const targetMs = appt.ms - win.minutesBefore * 60 * 1000;
    const diffMs = now - targetMs;
    if (diffMs >= 0 && diffMs < 25 * 60 * 1000) wins.push({ ...win, isCatchUp: false });
  }
  if (wins.length === 0) {
    const c = determineCatchUpWindow(appt.ms, leadCreatedMs, now);
    if (c) wins.push(c);
  }
  return wins;
}

// ── Postgres atomic claim primitives ──────────────────────────────────────

async function claimFresh(key, leadId, apptDate, windowKey, owner) {
  const { rows } = await db.query(
    `INSERT INTO reminder_claims
       (reminder_key, lead_id, appointment_date, reminder_window, status, owner, lease_expires_at, attempts)
     VALUES ($1, $2, $3, $4, 'processing', $5, NOW() + INTERVAL '120 seconds', 0)
     ON CONFLICT (reminder_key) DO NOTHING
     RETURNING *`,
    [key, leadId, apptDate, windowKey, owner]
  );
  return rows[0] || null;
}

async function claimExpiredLease(key, owner) {
  const { rows } = await db.query(
    `UPDATE reminder_claims
     SET owner = $2,
         lease_expires_at = NOW() + INTERVAL '120 seconds',
         attempts = attempts + 1,
         status = 'processing'
     WHERE reminder_key = $1
       AND status IN ('processing', 'failed')
       AND lease_expires_at < NOW()
     RETURNING *`,
    [key, owner]
  );
  return rows[0] || null;
}

async function markSent(claimId, messageIds) {
  await db.query(
    `UPDATE reminder_claims
     SET status = 'sent', sent_at = NOW(), gmail_message_ids = $2::jsonb, last_error = NULL, last_error_type = NULL
     WHERE id = $1`,
    [claimId, JSON.stringify(messageIds)]
  );
}

async function markFailed(claimId, errorType, errorMessage, backoffSeconds) {
  await db.query(
    `UPDATE reminder_claims
     SET status = 'failed', last_error = $2, last_error_type = $3,
         lease_expires_at = NOW() + make_interval(secs => $4)
     WHERE id = $1`,
    [claimId, errorMessage, errorType, backoffSeconds]
  );
}

// ── Base44 Activity write retry queue ───────────────────────────────────────

async function enqueueActivity(leadId, key, err) {
  await db.query(
    `INSERT INTO reminder_activity_queue (lead_id, reminder_key, last_error, next_attempt_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')`,
    [leadId, key, (err && err.message) || String(err)]
  );
}

async function flushActivityQueue() {
  const { rows } = await db.query(
    `SELECT * FROM reminder_activity_queue WHERE next_attempt_at <= NOW() ORDER BY created_at LIMIT 50`
  );
  for (const r of rows) {
    try {
      await crmRepository.writeReminderSentActivity({ leadId: r.lead_id, reminderKey: r.reminder_key });
      await db.query(`DELETE FROM reminder_activity_queue WHERE id = $1`, [r.id]);
    } catch (e) {
      const nextAttempts = (r.attempts || 0) + 1;
      if (nextAttempts >= 10) {
        // Give up after 10 attempts — the reminder is still 'sent' in Postgres;
        // only the CRM-display Activity is dropped.
        await db.query(`DELETE FROM reminder_activity_queue WHERE id = $1`, [r.id]);
        console.error(`[engine] Activity write permanently failed for ${r.reminder_key}: ${e.message}`);
      } else {
        await db.query(
          `UPDATE reminder_activity_queue SET attempts = $2, last_error = $3, next_attempt_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
          [r.id, nextAttempts, e.message]
        );
      }
    }
  }
}

// ── Email dispatch for one window ──────────────────────────────────────────

async function sendWindowEmails(lead, win, appt, gmailToken) {
  const isCatchUp = !!win.isCatchUp;
  const isPhoneCall = appt.type === 'Phone Call';
  const label = windowLabel(win.key);
  const ownerEmail = resolveOwnerEmail(lead.assigned_rep) || MICHELLE_EMAIL;
  const ownerDisplayName = lead.assigned_rep || 'Michelle';
  const address = [lead.property_address, lead.city].filter(Boolean).join(', ') || '';
  const dateFormatted = time.formatDate(appt.date);
  const timeFormatted = time.fmt12(appt.time);
  const clientFullName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  const staffRecipients = Array.from(new Set([ownerEmail, MICHELLE_EMAIL, YARON_EMAIL]));

  const messageIds = [];
  let hadFailure = false;
  let lastError = '';
  let errorType = '';
  let credentialError = '';

  const sendCustomer = !lead.customer_reminders_disabled && !!lead.email;
  const sendStaff = win.notifyStaff || isCatchUp;

  if (sendCustomer) {
    const subject = isPhoneCall
      ? (isCatchUp ? `Your Phone Call is Confirmed — ${COMPANY_NAME}` : `Phone Call Reminder in ${label} — ${COMPANY_NAME}`)
      : (isCatchUp ? `Your Appointment is Confirmed — ${COMPANY_NAME}` : `Appointment Reminder in ${label} — ${COMPANY_NAME}`);
    const body = isPhoneCall
      ? emails.clientPhoneCallEmail({ firstName: lead.first_name || 'there', date: dateFormatted, time: timeFormatted, phone: lead.phone || 'N/A', projectType: lead.project_type || 'your project', address, ownerName: ownerDisplayName, label, isCatchUp })
      : emails.clientMeetingEmail({ firstName: lead.first_name || 'there', date: dateFormatted, time: timeFormatted, address, projectType: lead.project_type || 'your project', ownerName: ownerDisplayName, label, isCatchUp });
    try {
      const r = await gmail.sendEmail(gmailToken, { to: lead.email, subject, htmlBody: body });
      messageIds.push(r.id);
      console.log(`[engine] ✉️ CLIENT → ${lead.email} (${clientFullName}, ${win.key}${isCatchUp ? ' catch-up' : ''}) id=${r.id}`);
    } catch (e) {
      if (e instanceof gmail.GmailCredentialsError) return { messageIds, hadFailure: true, credentialError: e.message, lastError: e.message, errorType: 'gmail_credentials' };
      hadFailure = true; lastError = e.message; errorType = 'gmail_send';
      console.error(`[engine] ❌ CLIENT send failed → ${lead.email}: ${e.message}`);
    }
  }

  if (sendStaff && !credentialError) {
    const subject = isCatchUp
      ? `📅 New Appointment: ${clientFullName} — ${dateFormatted} at ${timeFormatted}`
      : `${isPhoneCall ? 'Phone Call' : 'Appointment'} in ${label}: ${clientFullName}`;
    const body = emails.repReminderEmail({
      ownerName: ownerDisplayName, clientName: clientFullName,
      clientPhone: lead.phone || 'N/A', clientEmail: lead.email || 'N/A',
      date: dateFormatted, time: timeFormatted, address,
      projectType: lead.project_type || '', budget: lead.budget_range || '',
      notes: lead.notes || '', label, leadId: lead.id, isPhoneCall, isCatchUp,
    });
    for (const recipient of staffRecipients) {
      try {
        const r = await gmail.sendEmail(gmailToken, { to: recipient, subject, htmlBody: body });
        messageIds.push(r.id);
        console.log(`[engine] ✉️ STAFF → ${recipient} (${clientFullName}, ${win.key}${isCatchUp ? ' catch-up' : ''}) id=${r.id}`);
      } catch (e) {
        if (e instanceof gmail.GmailCredentialsError) return { messageIds, hadFailure: true, credentialError: e.message, lastError: e.message, errorType: 'gmail_credentials' };
        hadFailure = true; lastError = e.message; errorType = 'gmail_send';
        console.error(`[engine] ❌ STAFF send failed → ${recipient}: ${e.message}`);
      }
    }
  }

  return { messageIds, hadFailure, credentialError, lastError, errorType };
}

// ── Main entry ─────────────────────────────────────────────────────────────

async function processReminders({ dryRun = false, triggeredBy = 'manual' } = {}) {
  const startedAt = Date.now();
  await db.ensureSchema();
  await health.recordRunStart();
  const owner = `${os.hostname()}:${process.pid}`;
  const stats = { scanned: 0, eligible: 0, sent: 0, skipped: 0, failed: 0, windows: [] };

  console.log(`[engine] ══ RUN START ══ dryRun=${dryRun} by=${triggeredBy} owner=${owner} now=${new Date(startedAt).toISOString()}`);

  // Flush any pending Base44 Activity writes from prior runs.
  try { await flushActivityQueue(); } catch (e) { console.error('[engine] flushActivityQueue error:', e.message); }

  // Global Gmail credential lock — if set, do not send anything.
  const locked = await health.isGmailLocked();
  if (locked) {
    await health.recordRunSkipped('gmail_credentials_lock_active');
    console.error('[engine] gmail_credentials_lock active — skipping run (clear via POST /reminders/clear-gmail-lock after fixing the refresh token)');
    return { ok: false, skipped: true, reason: 'gmail_credentials_lock_active', durationMs: Date.now() - startedAt, dryRun, stats };
  }

  // Dry-run: candidate selection only — no claims, no sends, no Activity writes.
  if (dryRun) {
    let gmailOk = true;
    try { await gmail.refreshAccessToken(); await health.recordGmailOk(); }
    catch (e) {
      gmailOk = false;
      if (e instanceof gmail.GmailCredentialsError) {
        await health.recordGmailCredentialsInvalid(e.message);
        await alerts.dispatchAlert({ level: 'critical', type: 'gmail_credentials_invalid', message: `Gmail refresh token invalid: ${e.message}` });
      }
    }
    const leads = await crmRepository.listEligibleLeads();
    stats.scanned = leads.length;
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    for (const lead of leads) {
      const appt = getAppointmentMs(lead);
      if (!appt) continue;
      if (appt.type === 'Phone Call') continue;
      if (appt.ms < now - 3600000) continue;
      if (appt.ms > now + sevenDaysMs) continue;
      const leadCreatedMs = lead.crm_created_date ? new Date(lead.crm_created_date).getTime() : new Date(lead.created_date).getTime();
      const wins = computeWindowsForLead(appt, leadCreatedMs, now);
      for (const w of wins) {
        stats.eligible++;
        stats.windows.push({ lead: lead.id, key: w.key, isCatchUp: !!w.isCatchUp, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() });
      }
    }
    const dur = Date.now() - startedAt;
    await health.recordDryRun(stats, dur, gmailOk);
    console.log(`[engine] ══ DRY RUN END ══ scanned=${stats.scanned} eligible=${stats.eligible} gmailOk=${gmailOk} dur=${dur}ms`);
    return { ok: true, dryRun: true, gmailOk, stats, durationMs: dur, triggeredBy };
  }

  // Real run: refresh Gmail token.
  let gmailToken;
  try {
    gmailToken = await gmail.refreshAccessToken();
    await health.recordGmailOk();
  } catch (e) {
    const dur = Date.now() - startedAt;
    if (e instanceof gmail.GmailCredentialsError) {
      await health.recordGmailCredentialsInvalid(e.message);
      await alerts.dispatchAlert({ level: 'critical', type: 'gmail_credentials_invalid', message: `Gmail refresh token invalid: ${e.message}` });
      await health.recordRunFailure(e, 'gmail_credentials', dur);
      return { ok: false, error: e.message, errorType: 'gmail_credentials', durationMs: dur, stats };
    }
    await health.recordRunFailure(e, 'transient', dur);
    await alerts.dispatchAlert({ level: 'warning', type: 'run_failed', message: `Reminder run failed (transient): ${e.message}` });
    return { ok: false, error: e.message, errorType: 'transient', durationMs: dur, stats };
  }

  const leads = await crmRepository.listEligibleLeads();
  stats.scanned = leads.length;
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let abortRun = false;

  for (const lead of leads) {
    if (abortRun) break;
    const appt = getAppointmentMs(lead);
    if (!appt) continue;
    if (appt.type === 'Phone Call') continue; // parity: phone-call reminders disabled
    if (appt.ms < now - 3600000) continue;       // >1h past
    if (appt.ms > now + sevenDaysMs) continue;   // >7d out

    const clientFullName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    const leadCreatedMs = lead.crm_created_date ? new Date(lead.crm_created_date).getTime() : new Date(lead.created_date).getTime();
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);

    for (const w of wins) {
      if (abortRun) break;
      const key = reminderKey(lead.id, w.key, appt.date);

      // 1. Atomic claim in Postgres.
      let claim = await claimFresh(key, lead.id, appt.date, w.key, owner);
      if (!claim) claim = await claimExpiredLease(key, owner);
      if (!claim) { stats.skipped++; continue; } // already sent / live / backing off

      // 2-3. Send + collect Gmail message ids.
      const sendRes = await sendWindowEmails(lead, w, appt, gmailToken);

      if (sendRes.credentialError) {
        await markFailed(claim.id, 'gmail_credentials', sendRes.credentialError, 3600);
        await health.recordGmailCredentialsInvalid(sendRes.credentialError);
        await alerts.dispatchAlert({ level: 'critical', type: 'gmail_credentials_invalid', message: `Gmail send failed (credentials): ${sendRes.credentialError}` });
        stats.failed++; abortRun = true; break;
      }

      if (sendRes.hadFailure) {
        await markFailed(claim.id, sendRes.errorType || 'gmail_send', sendRes.lastError || 'send failed', 1800);
        stats.failed++;
        continue;
      }

      // 4. Mark claim sent.
      await markSent(claim.id, sendRes.messageIds);

      if (sendRes.messageIds.length > 0) {
        // 5. Write legacy REMINDER_SENT Activity to Base44 (best-effort, queued on failure).
        try {
          await crmRepository.writeReminderSentActivity({ leadId: lead.id, reminderKey: key });
        } catch (e) {
          await enqueueActivity(lead.id, key, e);
          console.warn(`[engine] Activity write failed, queued for retry: ${e.message}`);
        }
        await health.recordReminderSent(lead.id, w.key);
        stats.sent++;
        console.log(`[engine] ✓ ${w.key}${w.isCatchUp ? ' (catch-up)' : ''} for ${clientFullName} (${lead.id})`);
      } else {
        // Nothing to send this window (e.g. customer opted out + no staff window).
        // Mark sent with empty ids to avoid re-claim hammering; no Activity written.
        stats.skipped++;
      }
    }
  }

  const dur = Date.now() - startedAt;
  if (abortRun) {
    await health.recordRunFailure(new Error('gmail_credentials during run'), 'gmail_credentials', dur);
  } else {
    await health.recordRunSuccess(stats, dur);
  }
  console.log(`[engine] ══ RUN END ══ scanned=${stats.scanned} sent=${stats.sent} skipped=${stats.skipped} failed=${stats.failed} dur=${dur}ms`);
  return { ok: !abortRun, dryRun: false, stats, durationMs: dur, triggeredBy };
}

module.exports = { processReminders, REMINDER_WINDOWS, reminderKey, computeWindowsForLead, getAppointmentMs };