/* eslint-disable no-undef */
/**
 * Phone-call reminder engine (Railway-owned) — the Railway equivalent of the
 * Base44 `sendPhoneCallReminders` automation.
 *
 * Behavior is ported to match the live Base44 function exactly:
 *   - windows: 1h, 30min before the call.
 *   - recipients per window: owner (resolved from assigned_rep) + Michelle,
 *     plus the customer (suppressed if opted out / no email). Michelle is
 *     always copied; if there is no owner, Michelle is the owner and a
 *     no-owner alert is sent instead.
 *   - sender: yaron@ecconstructiongroup.com (EC Construction Group).
 *   - timezone: Pacific-local follow_up_time -> UTC (reminderTime.pacificToUtcMs).
 *   - idempotency: deterministic keys `phone_reminder:{leadId}:{window}:{date}`
 *     + Postgres reminder_claims (same table/claim primitives as appointments).
 *   - CRM visibility: `PHONE_REMINDER_SENT:{phone_reminder:...}` Activity,
 *     written best-effort via the reminder activity queue.
 *
 * Transport gate: EMAIL_PHONE_CALL_REMINDER_TRANSPORT (default 'base44').
 *   - 'base44' (default): this engine sends NOTHING and writes no claims.
 *     The live Base44 `sendPhoneCallReminders` automation remains the sole
 *     sender and MUST stay active until this is verified and flipped.
 *   - 'railway': real/dry-run processing per REMINDER_DRY_RUN.
 *
 * Real sending stays disabled. No Base44 automation is disabled by this file.
 */
'use strict';

const db = require('../db/client');
const time = require('./reminderTime');
const emails = require('./reminderEmails');
const crmRepository = require('./crmRepository');
const transport = require('./transportControl');

const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const COMPANY_FROM_NAME = 'EC Construction Group';
const SENDER = YARON_EMAIL;

const PHONE_WINDOWS = [
  { key: '1h', minutesBefore: 60 },
  { key: '30min', minutesBefore: 30 },
];

function windowLabel(key) {
  return { '1h': '1 hour', '30min': '30 minutes' }[key] || key;
}

function phoneKey(leadId, windowKey, date) {
  return `phone_reminder:${leadId}:${windowKey}:${date}`;
}

function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const direct = String(ownerName).trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(direct)) return direct;
  const first = ownerName.trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@ecconstructiongroup.com` : null;
}

function getCallMs(lead) {
  if (lead.follow_up_type !== 'Phone Call') return null;
  if (!lead.follow_up_date || !lead.follow_up_time) return null;
  return {
    ms: time.pacificToUtcMs(lead.follow_up_date, lead.follow_up_time),
    date: lead.follow_up_date,
    time: lead.follow_up_time,
  };
}

async function claimFresh(key, leadId, apptDate, windowKey, owner) {
  const { rows } = await db.query(
    `INSERT INTO reminder_claims (reminder_key, lead_id, appointment_date, reminder_window, status, owner, lease_expires_at, attempts)
     VALUES ($1, $2, $3, $4, 'processing', $5, NOW() + INTERVAL '120 seconds', 0)
     ON CONFLICT (reminder_key) DO NOTHING RETURNING *`,
    [key, leadId, apptDate, windowKey, owner]
  );
  return rows[0] || null;
}
async function markSent(claimId, messageIds) {
  await db.query(`UPDATE reminder_claims SET status='sent', sent_at=NOW(), gmail_message_ids=$2::jsonb, last_error=NULL, last_error_type=NULL WHERE id=$1`, [claimId, JSON.stringify(messageIds)]);
}
async function markFailed(claimId, errorType, errorMessage, backoffSeconds) {
  await db.query(`UPDATE reminder_claims SET status='failed', last_error=$2, last_error_type=$3, lease_expires_at=NOW()+make_interval(secs=>$4) WHERE id=$1`, [claimId, errorMessage, errorType, backoffSeconds]);
}
async function enqueueActivity(leadId, key, err) {
  await db.query(`INSERT INTO reminder_activity_queue (lead_id, reminder_key, last_error, next_attempt_at) VALUES ($1,$2,$3,NOW()+INTERVAL '60 seconds')`, [leadId, key, (err && err.message) || String(err)]);
}

async function processPhoneCallReminders({ dryRun = false, triggeredBy = 'manual' } = {}) {
  const startedAt = Date.now();
  const stats = { scanned: 0, eligible: 0, sent: 0, skipped: 0, failed: 0 };

  // Transport gate FIRST — when Base44 owns this flow (default) return skipped
  // without touching the database, so the worker needs no DB to honor the gate.
  const t = transport.flowTransport('PHONE_CALL_REMINDER');
  transport.logDecision('PHONE_CALL_REMINDER', t, null, { dryRun, triggeredBy });
  if (t === 'base44') {
    console.log('[phone] SKIP: EMAIL_PHONE_CALL_REMINDER_TRANSPORT=base44 (Base44 automation is the active sender)');
    return { ok: true, skipped: true, reason: 'phone_transport_base44', durationMs: Date.now() - startedAt, stats };
  }

  await db.ensureSchema();
  const emailService = require('./emailService');
  const gmail = require('./gmailSender');

  if (dryRun) {
    const leads = await crmRepository.listEligibleLeads();
    stats.scanned = leads.length;
    const now = Date.now();
    for (const lead of leads) {
      const call = getCallMs(lead);
      if (!call) continue;
      if (call.ms < now - 3600000 || call.ms > now + 7 * 24 * 3600000) continue;
      for (const win of PHONE_WINDOWS) {
        const targetMs = call.ms - win.minutesBefore * 60 * 1000;
        const diff = now - targetMs;
        if (diff >= 0 && diff < 15 * 60 * 1000) stats.eligible++;
      }
    }
    console.log(`[phone] DRY RUN scanned=${stats.scanned} eligible=${stats.eligible}`);
    return { ok: true, dryRun: true, stats, durationMs: Date.now() - startedAt };
  }

  const os = require('os');
  const owner = `${os.hostname()}:${process.pid}`;
  const leads = await crmRepository.listEligibleLeads();
  stats.scanned = leads.length;
  const now = Date.now();
  let abortRun = false;

  for (const lead of leads) {
    if (abortRun) break;
    const call = getCallMs(lead);
    if (!call) continue;
    if (call.ms < now - 3600000 || call.ms > now + 7 * 24 * 3600000) continue;

    const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    let ownerEmail = resolveOwnerEmail(lead.assigned_rep);
    const noOwner = !ownerEmail;
    if (noOwner) ownerEmail = MICHELLE_EMAIL;
    const ownerDisplayName = lead.assigned_rep || 'Michelle';
    const dateFormatted = time.formatDate(call.date);
    const timeFormatted = time.fmt12(call.time);
    const recipients = Array.from(new Set([ownerEmail, MICHELLE_EMAIL]));

    for (const win of PHONE_WINDOWS) {
      const targetMs = call.ms - win.minutesBefore * 60 * 1000;
      const diff = now - targetMs;
      if (diff < 0 || diff >= 15 * 60 * 1000) continue;
      const key = phoneKey(lead.id, win.key, call.date);
      const claim = await claimFresh(key, lead.id, call.date, win.key, owner);
      if (!claim) { stats.skipped++; continue; }

      const label = windowLabel(win.key);
      const address = [lead.property_address, lead.city].filter(Boolean).join(', ') || '';
      const messageIds = [];
      let hadFailure = false;
      let credentialError = '';
      let lastError = '';

      const ownerSubject = `Phone Call Reminder in ${label}: ${clientName}`;
      // Reuse the shared staff reminder template (repReminderEmail) for the
      // owner internal reminder, matching Base44 staff phone-call layout.
      const ownerBody = emails.repReminderEmail({
        ownerName: ownerDisplayName, clientName, clientPhone: lead.phone || 'N/A', clientEmail: lead.email || 'N/A',
        date: dateFormatted, time: timeFormatted, address, projectType: lead.project_type || '', budget: lead.budget_range || '',
        notes: lead.notes || '', label, leadId: lead.id, isPhoneCall: true, isCatchUp: false,
      });

      for (const recipient of recipients) {
        try {
          const r = await emailService.send({ to: recipient, subject: ownerSubject, htmlBody: ownerBody, fromName: COMPANY_FROM_NAME, fromAddress: SENDER, idempotencyKey: `phone-reminder:${lead.id}:${win.key}:${call.date}:staff:${recipient}` });
          if (r && r.gmailMessageId) messageIds.push(r.gmailMessageId);
        } catch (e) {
          if (e instanceof gmail.GmailCredentialsError) { credentialError = e.message; abortRun = true; break; }
          hadFailure = true; lastError = e.message;
        }
      }
      if (credentialError) { await markFailed(claim.id, 'gmail_credentials', credentialError, 3600); stats.failed++; break; }

      if (noOwner) {
        try {
          await emailService.send({
            to: MICHELLE_EMAIL, subject: `⚠️ Phone call with no owner: ${clientName} on ${call.date}`,
            htmlBody: `<p>Hi Michelle,</p><p>A phone call follow-up has no assigned owner.</p><p><strong>Client:</strong> ${clientName}<br><strong>Date:</strong> ${call.date} at ${call.time}<br><strong>Phone:</strong> ${lead.phone || '—'}<br><strong>Email:</strong> ${lead.email || '—'}</p><p><a href="${process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com'}/leads/${lead.id}">Please assign an owner in CRM →</a></p><p>— EC CRM</p>`,
            fromName: 'EC Construction Group CRM', fromAddress: SENDER, idempotencyKey: `no_owner_alert:${lead.id}:${call.date}`,
          });
        } catch (e) { /* best-effort alert */ }
      }

      if (!lead.customer_reminders_disabled && lead.email) {
        const clientSubject = `Phone Call Reminder in ${label} — EC Construction Group`;
        const clientBody = emails.clientPhoneCallEmail({
          firstName: lead.first_name || 'there', date: dateFormatted, time: timeFormatted, phone: lead.phone || 'N/A',
          projectType: lead.project_type || 'your project', address, ownerName: ownerDisplayName, label, isCatchUp: false,
        });
        try {
          const r = await emailService.send({ to: lead.email, subject: clientSubject, htmlBody: clientBody, fromName: COMPANY_FROM_NAME, fromAddress: SENDER, idempotencyKey: `phone-reminder:${lead.id}:${win.key}:${call.date}:customer:${lead.email}` });
          if (r && r.gmailMessageId) messageIds.push(r.gmailMessageId);
        } catch (e) {
          if (e instanceof gmail.GmailCredentialsError) { credentialError = e.message; abortRun = true; break; }
          hadFailure = true; lastError = e.message;
        }
      }
      if (credentialError) { await markFailed(claim.id, 'gmail_credentials', credentialError, 3600); stats.failed++; break; }

      if (hadFailure) { await markFailed(claim.id, 'gmail_send', lastError || 'send failed', 1800); stats.failed++; continue; }
      await markSent(claim.id, messageIds);
      try { await crmRepository.writeReminderSentActivity({ leadId: lead.id, reminderKey: `PHONE_REMINDER_SENT:${key}` }); }
      catch (e) { await enqueueActivity(lead.id, `PHONE_REMINDER_SENT:${key}`, e); }
      stats.sent++;
      console.log(`[phone] ✓ ${win.key} for ${clientName} (${lead.id})`);
    }
  }

  console.log(`[phone] RUN END scanned=${stats.scanned} sent=${stats.sent} skipped=${stats.skipped} failed=${stats.failed}`);
  return { ok: !abortRun, dryRun: false, stats, durationMs: Date.now() - startedAt, triggeredBy };
}

module.exports = { processPhoneCallReminders, PHONE_WINDOWS, phoneKey, getCallMs };