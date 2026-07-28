/* eslint-disable no-undef */
/**
 * Task reminder engine (Railway-owned) — the Railway equivalent of the Base44
 * `sendTaskReminders` automation (scheduled every 15 min).
 *
 * Behavior matches the live Base44 function:
 *   - selects incomplete tasks whose due_date(+due_time) falls within the
 *     next 15-minute window (0 <= due - now <= 15min).
 *   - recipient: task.assigned_to, else the related lead's assigned_rep.
 *     No recipient => skip (no send).
 *   - sender: yaron@ecconstructiongroup.com (EC Construction Group CRM).
 *   - subject: `⏰ Task Reminder: <title>` (RFC 2047 encoded by EmailService).
 *   - body: the same gold-header card template.
 *   - idempotency: deterministic `task-reminder:{taskId}:{dueIso}` keys via
 *     EmailService claims (UNIQUE idempotency_key).
 *   - missing assignee => skip; errors logged per task; one task failure
 *     does not abort the run (best-effort, like Base44).
 *
 * Transport gate: EMAIL_TASK_REMINDER_TRANSPORT (default 'base44').
 *   - 'base44' (default): sends NOTHING. The live Base44 `sendTaskReminders`
 *     automation remains the sole sender and MUST stay active.
 *   - 'railway': real/dry-run processing per REMINDER_DRY_RUN.
 *
 * Real sending stays disabled. No Base44 automation is disabled by this file.
 * Data source: [TEMPORARY] Base44 Task entity via lib/base44.js (service-role).
 */
'use strict';

const b44 = require('./base44');
const transport = require('./transportControl');

const SENDER = 'yaron@ecconstructiongroup.com';
const FROM_NAME = 'EC Construction Group CRM';
const NAVY = '#0B2D5C';
const GOLD = '#C9A227';
const WINDOW_MS = 15 * 60 * 1000;

function taskKey(taskId, dueIso) {
  return `task-reminder:${taskId}:${dueIso}`;
}

function taskBody({ title, dueDate, dueTime, leadName, notes }) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="background:${GOLD};padding:12px 20px;border-radius:4px 4px 0 0;">
    <h2 style="color:${NAVY};margin:0;font-size:16px;text-transform:uppercase;letter-spacing:2px;">⏰ Task Reminder</h2>
  </div>
  <div style="background:#f9f9f9;border:1px solid #e0e0e0;padding:20px;border-radius:0 0 4px 4px;">
    <h3 style="color:#1a1a1a;margin-top:0;">${title}</h3>
    <p style="color:#555;"><strong>Due:</strong> ${dueDate} at ${dueTime}</p>
    ${leadName ? `<p style="color:#555;"><strong>Related to:</strong> ${leadName}</p>` : ''}
    ${notes ? `<p style="color:#555;"><strong>Notes:</strong> ${notes}</p>` : ''}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0;" />
    <p style="color:#888;font-size:12px;">This is an automated reminder from EC Construction Group CRM.</p>
  </div>
</div>`.trim();
}

async function listDueSoonTasks() {
  const allTasks = await b44.filter('Task', { completed: false }).catch(() => []);
  const now = Date.now();
  return (allTasks || []).filter(task => {
    if (!task.due_date) return false;
    const dateStr = task.due_date + (task.due_time ? `T${task.due_time}` : 'T09:00');
    const dueAt = new Date(dateStr).getTime();
    const diff = dueAt - now;
    return diff >= 0 && diff <= WINDOW_MS;
  });
}

async function processTaskReminders({ dryRun = false, triggeredBy = 'manual' } = {}) {
  const startedAt = Date.now();
  const stats = { scanned: 0, eligible: 0, sent: 0, skipped: 0, failed: 0 };

  const t = transport.flowTransport('TASK_REMINDER');
  transport.logDecision('TASK_REMINDER', t, null, { dryRun, triggeredBy });
  if (t === 'base44') {
    console.log('[task] SKIP: EMAIL_TASK_REMINDER_TRANSPORT=base44 (Base44 automation is the active sender)');
    return { ok: true, skipped: true, reason: 'task_transport_base44', durationMs: Date.now() - startedAt, stats };
  }

  const dueSoon = await listDueSoonTasks();
  stats.scanned = dueSoon.length;
  stats.eligible = dueSoon.length;

  if (dryRun) {
    console.log(`[task] DRY RUN eligible=${stats.eligible}`);
    return { ok: true, dryRun: true, stats, durationMs: Date.now() - startedAt };
  }

  const emailService = require('./emailService');
  const gmail = require('./gmailSender');

  for (const task of dueSoon) {
    let lead = null;
    if (task.lead_id) {
      try { lead = await b44.get('Lead', task.lead_id).catch(() => null); } catch (_) {}
    }
    const notifyEmail = task.assigned_to
      || (lead && lead.assigned_rep && /^[\w.+-]+@[\w-]+\.\w+$/.test(lead.assigned_rep) ? lead.assigned_rep : null)
      || (lead && lead.assigned_rep ? `${lead.assigned_rep.trim().split(/\s+/)[0].toLowerCase()}@ecconstructiongroup.com` : null);
    if (!notifyEmail) { stats.skipped++; continue; }

    const dueTime = task.due_time || '09:00';
    const dueDate = new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const leadName = lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : '';
    const dueIso = `${task.due_date}T${dueTime}`;

    try {
      await emailService.send({
        to: notifyEmail, subject: `⏰ Task Reminder: ${task.title}`,
        htmlBody: taskBody({ title: task.title, dueDate, dueTime, leadName: leadName || '', notes: task.notes || '' }),
        fromName: FROM_NAME, fromAddress: SENDER, idempotencyKey: taskKey(task.id, dueIso), role: 'task',
      });
      stats.sent++;
      console.log(`[task] ✓ Sent to ${notifyEmail} for task ${task.id}`);
    } catch (e) {
      stats.failed++;
      if (e instanceof gmail.GmailCredentialsError) {
        console.error(`[task] ❌ Credential error (aborting): ${e.message}`);
        stats.failed = dueSoon.length - stats.sent - stats.skipped;
        break;
      }
      console.error(`[task] ❌ Failed task ${task.id}: ${e.message}`);
    }
  }

  console.log(`[task] RUN END scanned=${stats.scanned} sent=${stats.sent} skipped=${stats.skipped} failed=${stats.failed}`);
  return { ok: true, dryRun: false, stats, durationMs: Date.now() - startedAt, triggeredBy };
}

module.exports = { processTaskReminders, taskKey, taskBody, listDueSoonTasks };