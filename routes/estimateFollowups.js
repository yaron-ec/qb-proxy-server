/* eslint-disable no-undef */
/**
 * estimateFollowups — REST surface for the automated 14-day estimate
 * follow-up email sequence (see lib/estimateFollowupEngine.js for the
 * actual scheduling/send logic this is a thin HTTP layer over).
 *
 *   Lead-scoped (requireAuth + the SAME routes/leads.js#resolveOwnerScope
 *   ownership filter every other lead sub-resource reuses — admin/manager
 *   see everything, office is read-only, sales_rep only their own leads):
 *     GET  /api/v1/leads/:id/estimate-followup
 *     GET  /api/v1/leads/:id/estimate-followup/preview
 *     POST /api/v1/leads/:id/estimate-followup/confirm-sent
 *     POST /api/v1/leads/:id/estimate-followup/manual-enroll
 *     POST /api/v1/leads/:id/estimate-followup/pause
 *     POST /api/v1/leads/:id/estimate-followup/resume
 *     POST /api/v1/leads/:id/estimate-followup/stop
 *
 *   Admin/manager-only (global oversight, never a per-lead ownership check):
 *     GET  /api/v1/estimate-followups/admin/overview
 *     GET  /api/v1/estimate-followups/admin/dry-run-report
 *     GET  /api/v1/estimate-followups/admin/automation-status
 *     GET  /api/v1/estimate-followups/admin/ambiguous-replies
 *     POST /api/v1/estimate-followups/admin/ambiguous-replies/:id/resolve
 *     GET  /api/v1/estimate-followups/admin/post-appointment-sync-status
 *       (failed/overdue post-appointment sync job monitoring — see
 *       lib/postAppointmentEstimateSync.js)
 *     GET  /api/v1/estimate-followups/templates
 *     GET  /api/v1/estimate-followups/templates/:key/history
 *     PUT  /api/v1/estimate-followups/templates/:key   (admin only — content/compliance edit)
 *
 *   Public, unauthenticated (a link clicked from inside a customer's email —
 *   mirrors lib/actionRouter.js's existing public action-page convention):
 *     GET  /api/v1/estimate-followups/public/unsubscribe/:token
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const engine = require('../lib/estimateFollowupEngine');
const eligibility = require('../lib/estimateFollowupEligibility');
const templates = require('../lib/estimateFollowupTemplates');
const replyDetection = require('../lib/estimateFollowupReplyDetection');

const router = express.Router();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * A genuinely unexpected failure must never leak a raw driver/Postgres
 * message to the client (same production-incident-driven convention as
 * routes/sms.js#logAndRespondUnexpectedError).
 */
function logAndRespondUnexpectedError(e, res, context) {
  console.error(`[estimate-followups] ${context} error:`, { message: e.message, code: e.code, stack: e.stack });
  res.status(500).json({ error: 'unexpected_error', message: 'Something went wrong. Please try again, or contact support if it keeps happening.' });
}

function respondConfigurationError(e, res) {
  if (e instanceof templates.ConfigurationError) {
    res.status(409).json({ error: 'configuration_error', message: e.message });
    return true;
  }
  return false;
}

async function loadLeadForScope(req, res) {
  const { resolveOwnerScope } = require('./leads');
  const scope = await resolveOwnerScope(req.user);
  if (scope.denied) { res.status(403).json({ error: 'forbidden' }); return null; }
  const { rows } = await query('SELECT id, owner_id, first_name, email FROM leads WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return null; }
  if (scope.ownerFilter && String(rows[0].owner_id) !== String(scope.ownerFilter)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return { lead: rows[0], scope };
}

// Used by BOTH the per-lead GET and the admin automation-status endpoint,
// so the two can never silently drift into two different field-casing
// conventions for the same underlying status (the exact class of bug this
// codebase has paid for before — see lib/qbEnvironment.js's header for the
// QB_ENVIRONMENT/QB_SANDBOX precedent).
function serializeReplyMonitoring(replyMonitoring) {
  return {
    enabled: replyMonitoring.enabled,
    notificationsEnabled: replyMonitoring.notifications_enabled,
    healthyForSending: replyMonitoring.healthy_for_sending,
    reason: replyMonitoring.reason,
    status: replyMonitoring.checkpoint ? replyMonitoring.checkpoint.status : 'unhealthy',
    lastCheckedAt: replyMonitoring.checkpoint ? replyMonitoring.checkpoint.last_checked_at : null,
    lastSuccessAt: replyMonitoring.checkpoint ? replyMonitoring.checkpoint.last_success_at : null,
    consecutiveFailures: replyMonitoring.checkpoint ? replyMonitoring.checkpoint.consecutive_failures : null,
    lastError: replyMonitoring.checkpoint ? replyMonitoring.checkpoint.last_error : null,
    unresolvedAmbiguousReplies: replyMonitoring.unresolved_ambiguous_replies,
  };
}

// Per-lead post-appointment sync visibility (CRM feature: "Automatic
// Post-Appointment QuickBooks Estimate Sync and Follow-Up Enrollment" —
// see lib/postAppointmentEstimateSync.js). Most recent appointments first
// — a lead can have more than one tracked appointment over time.
async function postAppointmentSyncsForLead(leadId) {
  const { rows } = await query(
    `SELECT p.id, p.status, p.attempt_number, p.next_attempt_at, p.last_attempt_at,
            p.last_result, p.last_error, p.stopped_reason, p.window_expires_at, p.created_at,
            a.id AS appointment_id, a.start_at, a.end_at, a.status AS appointment_status,
            t.name AS appointment_type_name,
            h.id AS handoff_estimate_id, h.qb_estimate_number, h.estimate_status,
            h.qb_email_status, h.qb_email_delivery_time, h.qb_app_url
       FROM post_appointment_estimate_syncs p
       JOIN appointments a ON a.id = p.appointment_id
       LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
       LEFT JOIN handoff_estimates h ON h.id = p.handoff_estimate_id
      WHERE p.lead_id = $1
      ORDER BY a.end_at DESC
      LIMIT 10`,
    [leadId]
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    attemptNumber: r.attempt_number,
    nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null,
    lastAttemptAt: r.last_attempt_at,
    lastResult: r.last_result,
    lastError: r.last_error,
    stoppedReason: r.stopped_reason,
    windowExpiresAt: r.window_expires_at,
    appointment: {
      id: r.appointment_id,
      startAt: r.start_at,
      endAt: r.end_at,
      status: r.appointment_status,
      typeName: r.appointment_type_name,
    },
    estimate: r.handoff_estimate_id ? {
      id: r.handoff_estimate_id,
      qbEstimateNumber: r.qb_estimate_number,
      estimateStatus: r.estimate_status,
      deliveryVerified: r.qb_email_status === 'EmailSent',
      qbAppUrl: r.qb_app_url,
    } : null,
  }));
}

function writeAllowed(scope, res) {
  if (scope.readOnly) {
    res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });
    return false;
  }
  return true;
}

async function pendingEstimatesForLead(leadId) {
  const { rows } = await query(
    `SELECT id, qb_estimate_number, estimate_status, created_at FROM handoff_estimates
       WHERE lead_id = $1 AND estimate_status = 'Pending' ORDER BY created_at DESC`,
    [leadId]
  );
  return rows;
}

/**
 * Resolves which estimate an enroll action applies to. Deliberately refuses
 * to guess when more than one Pending estimate exists on the same lead
 * (revised/multiple estimates) — the caller must pick explicitly. Returns
 * { estimateId } or { error, candidates? }.
 */
async function resolveEstimateForEnroll(leadId, explicitEstimateId) {
  if (explicitEstimateId) return { estimateId: explicitEstimateId };
  const candidates = await pendingEstimatesForLead(leadId);
  if (candidates.length === 0) return { error: 'no_pending_estimate' };
  if (candidates.length > 1) return { error: 'multiple_pending_estimates', candidates };
  return { estimateId: candidates[0].id };
}

function deriveDisplayState({ sequence, steps, eligibleNow }) {
  if (!sequence) return eligibleNow ? 'awaiting_sent_confirmation' : 'not_eligible';
  if (sequence.status === 'completed') return 'completed';
  if (sequence.status === 'stopped') return 'stopped';
  if (sequence.status === 'paused') return 'paused';
  const anySent = steps.some((s) => s.status === 'sent');
  const anyFailedTerminal = steps.some((s) => s.status === 'failed');
  if (anyFailedTerminal && !anySent) return 'failed';
  return anySent ? 'active' : 'scheduled';
}

function serializeSequence(sequence, steps) {
  if (!sequence) return null;
  return {
    id: sequence.id,
    status: sequence.status,
    recipientEmail: sequence.recipient_email,
    salesRepOwnerId: sequence.sales_rep_owner_id,
    handoffEstimateId: sequence.handoff_estimate_id,
    estimateSentConfirmedAt: sequence.estimate_sent_confirmed_at,
    estimateSentConfirmedBy: sequence.estimate_sent_confirmed_by,
    estimateSentConfirmationNote: sequence.estimate_sent_confirmation_note,
    enrollmentMethod: sequence.enrollment_method,
    pausedReason: sequence.paused_reason,
    pausedAt: sequence.paused_at,
    pausedBy: sequence.paused_by,
    triggeringGmailMessageId: sequence.triggering_gmail_message_id,
    stoppedReason: sequence.stopped_reason,
    stoppedAt: sequence.stopped_at,
    stoppedBy: sequence.stopped_by,
    completedAt: sequence.completed_at,
    createdAt: sequence.created_at,
    steps: steps.map((s) => ({
      id: s.id,
      stepNumber: s.step_number,
      dayOffset: s.day_offset,
      templateKey: s.template_key,
      dueAt: s.due_at,
      status: s.status,
      attempts: s.attempts,
      lastError: s.last_error,
      skippedReason: s.skipped_reason,
      sentAt: s.sent_at,
    })),
  };
}

// ── GET /leads/:id/estimate-followup — current state ────────────────────────
router.get('/leads/:id/estimate-followup', requireAuth, async (req, res) => {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead } = ctx;

    const sequence = await engine.getSequenceForLead(lead.id);
    const steps = sequence ? await engine.getStepsForSequence(sequence.id) : [];

    let eligibleNow = false;
    let eligibilityReasons = [];
    let candidateEstimates = [];
    if (!sequence) {
      candidateEstimates = await pendingEstimatesForLead(lead.id);
      if (candidateEstimates.length === 1) {
        const elig = await eligibility.checkEligibilityForEnrollment({ leadId: lead.id, handoffEstimateId: candidateEstimates[0].id });
        eligibleNow = elig.eligible;
        eligibilityReasons = elig.reasons;
      } else if (candidateEstimates.length === 0) {
        eligibilityReasons = ['no_pending_estimate'];
      } else {
        eligibilityReasons = ['multiple_pending_estimates'];
      }
    }

    const replyMonitoring = await replyDetection.getReplyMonitoringStatus();
    const postAppointmentSyncs = await postAppointmentSyncsForLead(lead.id);

    res.json({
      state: deriveDisplayState({ sequence, steps, eligibleNow }),
      sequence: serializeSequence(sequence, steps),
      eligibleNow,
      eligibilityReasons,
      candidateEstimates: sequence ? [] : candidateEstimates,
      // Automatic post-appointment QuickBooks sync tracking — see
      // lib/postAppointmentEstimateSync.js. Empty when this lead has no
      // tracked appointment yet (nothing to show, not an error).
      postAppointmentSyncs,
      // Reply detection is now automatic (Gmail history.list poll — see
      // lib/estimateFollowupReplyDetection.js) rather than the manual-only
      // limitation this field used to describe. Surfaced here (global
      // health, not lead-specific) so a rep can tell whether "no reply
      // detected yet" is trustworthy right now, or whether reply monitoring
      // is itself down/disabled — in which case lib/estimateFollowupEngine.js's
      // fail-closed gate is ALSO holding every due send for every sequence,
      // not just this one. Manual pause/stop below remain available as an
      // explicit override for exceptional cases regardless of this status.
      replyMonitoring: serializeReplyMonitoring(replyMonitoring),
    });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'get state'); }
});

// ── GET /leads/:id/estimate-followup/preview — all 6 rendered emails ───────
router.get('/leads/:id/estimate-followup/preview', requireAuth, async (req, res) => {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead } = ctx;

    const sequence = await engine.getSequenceForLead(lead.id);
    let salesRepName = null;
    if (sequence && sequence.sales_rep_owner_id) {
      const { rows } = await query('SELECT display_name FROM owners WHERE id = $1', [sequence.sales_rep_owner_id]);
      salesRepName = (rows[0] && rows[0].display_name) || null;
    } else if (lead.owner_id) {
      const { rows } = await query('SELECT display_name FROM owners WHERE id = $1', [lead.owner_id]);
      salesRepName = (rows[0] && rows[0].display_name) || null;
    }
    // A preview may be requested before enrollment exists — the unsubscribe
    // link still needs SOME sequence id to build a syntactically valid URL.
    // Using a random, never-persisted UUID here is safe: this is a PREVIEW
    // only, nothing is sent, and the link is clearly labeled as such.
    const previewSequenceId = sequence ? sequence.id : crypto.randomUUID();

    const previews = [];
    for (const step of templates.DEFAULT_SCHEDULE) {
      const rendered = await templates.renderEmailForStep({
        templateKey: step.templateKey,
        firstName: lead.first_name,
        salesRepName,
        unsubscribeUrl: engine.unsubscribeUrlFor(previewSequenceId),
      });
      previews.push({ stepNumber: step.stepNumber, dayOffset: step.dayOffset, templateKey: step.templateKey, subject: rendered.subject, html: rendered.html, templateVersion: rendered.templateVersion });
    }
    res.json({ previews, isLivePreview: !sequence });
  } catch (e) {
    if (respondConfigurationError(e, res)) return;
    logAndRespondUnexpectedError(e, res, 'preview');
  }
});

async function handleEnroll(req, res, method) {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead, scope } = ctx;
    if (!writeAllowed(scope, res)) return;

    const resolved = await resolveEstimateForEnroll(lead.id, req.body && req.body.handoffEstimateId);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error, candidates: resolved.candidates || [] });
    }

    const fn = method === 'manual_enroll' ? engine.manualEnroll : engine.confirmEstimateSent;
    const result = await fn({
      leadId: lead.id,
      handoffEstimateId: resolved.estimateId,
      confirmedBy: req.user.email,
      sentAt: (req.body && req.body.sentAt) || undefined,
      note: (req.body && req.body.note) || undefined,
    });
    res.json({ sequence: result.sequence });
  } catch (e) {
    if (e && e.code === 'not_eligible') return res.status(409).json({ error: 'not_eligible', reasons: e.reasons });
    logAndRespondUnexpectedError(e, res, 'enroll');
  }
}

router.post('/leads/:id/estimate-followup/confirm-sent', requireAuth, (req, res) => handleEnroll(req, res, 'confirm_sent'));
router.post('/leads/:id/estimate-followup/manual-enroll', requireAuth, requireRole('admin', 'manager'), (req, res) => handleEnroll(req, res, 'manual_enroll'));

router.post('/leads/:id/estimate-followup/pause', requireAuth, async (req, res) => {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead, scope } = ctx;
    if (!writeAllowed(scope, res)) return;
    const sequence = await engine.getSequenceForLead(lead.id);
    if (!sequence) return res.status(404).json({ error: 'no_sequence' });
    const updated = await engine.pauseSequence({ sequenceId: sequence.id, reason: (req.body && req.body.reason) || 'manual_pause', pausedBy: req.user.email });
    res.json({ sequence: updated });
  } catch (e) {
    if (String(e.message).includes('not found or not active')) return res.status(409).json({ error: 'not_active' });
    logAndRespondUnexpectedError(e, res, 'pause');
  }
});

router.post('/leads/:id/estimate-followup/resume', requireAuth, async (req, res) => {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead, scope } = ctx;
    if (!writeAllowed(scope, res)) return;
    const sequence = await engine.getSequenceForLead(lead.id);
    if (!sequence) return res.status(404).json({ error: 'no_sequence' });
    const updated = await engine.resumeSequence({ sequenceId: sequence.id, resumedBy: req.user.email });
    res.json({ sequence: updated });
  } catch (e) {
    if (String(e.message).includes('not found or not paused')) return res.status(409).json({ error: 'not_paused' });
    logAndRespondUnexpectedError(e, res, 'resume');
  }
});

router.post('/leads/:id/estimate-followup/stop', requireAuth, async (req, res) => {
  try {
    const ctx = await loadLeadForScope(req, res);
    if (!ctx) return;
    const { lead, scope } = ctx;
    if (!writeAllowed(scope, res)) return;
    const sequence = await engine.getSequenceForLead(lead.id);
    if (!sequence) return res.status(404).json({ error: 'no_sequence' });
    const updated = await engine.stopSequence({ sequenceId: sequence.id, reason: (req.body && req.body.reason) || 'manual_stop', stoppedBy: req.user.email });
    if (!updated) return res.status(409).json({ error: 'already_terminal' });
    res.json({ sequence: updated });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'stop'); }
});

// ── Admin/manager-only global oversight ─────────────────────────────────────
router.get('/estimate-followups/admin/overview', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT seq.status, l.id AS lead_id, l.first_name, l.last_name, seq.recipient_email,
              seq.sales_rep_owner_id, o.display_name AS sales_rep_name, seq.created_at,
              (SELECT COUNT(*) FROM estimate_followup_steps st WHERE st.sequence_id = seq.id AND st.status = 'sent') AS sent_count,
              (SELECT COUNT(*) FROM estimate_followup_steps st WHERE st.sequence_id = seq.id AND st.status = 'failed') AS failed_count
         FROM estimate_followup_sequences seq
         JOIN leads l ON l.id = seq.lead_id
         LEFT JOIN owners o ON o.id = seq.sales_rep_owner_id
        ORDER BY seq.created_at DESC
        LIMIT 500`
    );
    const byStatus = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    res.json({
      counts: byStatus,
      total: rows.length,
      sequences: rows.map((r) => ({
        leadId: r.lead_id, leadName: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        status: r.status, recipientEmail: r.recipient_email, salesRepName: r.sales_rep_name,
        createdAt: r.created_at, sentCount: Number(r.sent_count), failedCount: Number(r.failed_count),
      })),
    });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'admin overview'); }
});

router.get('/estimate-followups/admin/dry-run-report', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const report = await engine.getDryRunEligibilityReport();
    res.json(report);
  } catch (e) { logAndRespondUnexpectedError(e, res, 'dry-run report'); }
});

// ── Automation status (reply-monitoring health + unresolved ambiguous
//    replies) — read-only, admin/manager, for the global oversight page.
//    This is the one place an operator confirms the fail-closed gate's own
//    current state without needing Railway log access. ───────────────────
router.get('/estimate-followups/admin/automation-status', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const replyMonitoring = await replyDetection.getReplyMonitoringStatus();
    res.json({ replyMonitoring: serializeReplyMonitoring(replyMonitoring) });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'automation status'); }
});

// Admin monitoring for failed/overdue post-appointment sync jobs — read
// only, no write of any kind. "Overdue" means a 'pending' row whose
// next_attempt_at has already passed by more than OVERDUE_MINUTES: since
// the reminder worker tick (which calls
// lib/postAppointmentEstimateSync.js#processPostAppointmentEstimateSyncs)
// runs every ~30 minutes, a row still waiting well past that is a sign the
// worker tick itself isn't running, not a normal scheduling gap.
const POST_APPOINTMENT_SYNC_OVERDUE_MINUTES = 90;
router.get('/estimate-followups/admin/post-appointment-sync-status', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows: countRows } = await query(
      `SELECT status, COUNT(*) AS n FROM post_appointment_estimate_syncs GROUP BY status`
    );
    const counts = countRows.reduce((acc, r) => { acc[r.status] = Number(r.n); return acc; }, {});

    const { rows: overdueRows } = await query(
      `SELECT p.id, p.next_attempt_at, p.attempt_number, p.last_result, p.last_error,
              l.id AS lead_id, l.first_name, l.last_name
         FROM post_appointment_estimate_syncs p
         JOIN leads l ON l.id = p.lead_id
        WHERE p.status = 'pending' AND p.next_attempt_at < NOW() - INTERVAL '${POST_APPOINTMENT_SYNC_OVERDUE_MINUTES} minutes'
        ORDER BY p.next_attempt_at ASC
        LIMIT 100`
    );

    const { rows: erroredRows } = await query(
      `SELECT p.id, p.last_error, p.last_attempt_at, p.attempt_number,
              l.id AS lead_id, l.first_name, l.last_name
         FROM post_appointment_estimate_syncs p
         JOIN leads l ON l.id = p.lead_id
        WHERE p.last_result = 'error' AND p.status IN ('pending', 'processing')
        ORDER BY p.last_attempt_at DESC
        LIMIT 100`
    );

    res.json({
      counts,
      overdueMinutesThreshold: POST_APPOINTMENT_SYNC_OVERDUE_MINUTES,
      overdue: overdueRows.map((r) => ({
        id: r.id, leadId: r.lead_id, leadName: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        nextAttemptAt: r.next_attempt_at, attemptNumber: r.attempt_number, lastResult: r.last_result, lastError: r.last_error,
      })),
      recentErrors: erroredRows.map((r) => ({
        id: r.id, leadId: r.lead_id, leadName: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        lastAttemptAt: r.last_attempt_at, attemptNumber: r.attempt_number, lastError: r.last_error,
      })),
    });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'post-appointment sync status'); }
});

// Every inbound reply that could not be deterministically correlated to
// exactly one active/paused sequence (zero or multiple candidate leads) —
// never silently attached to a possibly-wrong lead. Manual staff triage is
// the explicit, exceptional-case override this requirement calls for.
router.get('/estimate-followups/admin/ambiguous-replies', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, gmail_message_id, gmail_thread_id, from_address, candidate_sequence_ids, reason, received_at, resolved, resolved_at, resolved_by, created_at
         FROM estimate_followup_ambiguous_replies
        ORDER BY resolved ASC, created_at DESC
        LIMIT 200`
    );
    res.json({ ambiguousReplies: rows });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'ambiguous replies'); }
});

router.post('/estimate-followups/admin/ambiguous-replies/:id/resolve', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE estimate_followup_ambiguous_replies SET resolved = TRUE, resolved_at = NOW(), resolved_by = $2
         WHERE id = $1 AND NOT resolved RETURNING *`,
      [req.params.id, req.user.email]
    );
    if (!rows.length) return res.status(409).json({ error: 'not_found_or_already_resolved' });
    res.json({ ambiguousReply: rows[0] });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'resolve ambiguous reply'); }
});

router.get('/estimate-followups/templates', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const list = await templates.listActiveTemplates();
    res.json({ templates: list });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'list templates'); }
});

router.get('/estimate-followups/templates/:key/history', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (!templates.TEMPLATE_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'unknown_template_key' });
    const history = await templates.getTemplateHistory(req.params.key);
    res.json({ history });
  } catch (e) { logAndRespondUnexpectedError(e, res, 'template history'); }
});

router.put('/estimate-followups/templates/:key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!templates.TEMPLATE_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'unknown_template_key' });
    const { subject, bodyHtml } = req.body || {};
    const saved = await templates.saveTemplateVersion({ templateKey: req.params.key, subject, bodyHtml, createdBy: req.user.email });
    res.json({ template: saved });
  } catch (e) {
    if (/is required/.test(e.message)) return res.status(400).json({ error: 'invalid_input', message: e.message });
    logAndRespondUnexpectedError(e, res, 'save template');
  }
});

// ── Public, unauthenticated unsubscribe link (clicked from inside a customer
//    email — never requires a login, mirrors lib/actionRouter.js's existing
//    public action-page convention) ─────────────────────────────────────────
function unsubscribePageHtml({ ok, message }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Unsubscribe — EC Construction Group</title>
  <style>body{font-family:-apple-system,Arial,sans-serif;background:#EEF1F7;color:#1A1A2E;padding:40px 16px;text-align:center;}
  .card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  h1{font-size:20px;color:#0B2D5C;margin-bottom:12px;}p{font-size:15px;color:#444;}</style></head>
  <body><div class="card"><h1>${ok ? 'You have been unsubscribed' : 'Unable to process request'}</h1><p>${esc(message)}</p></div></body></html>`;
}

router.get('/estimate-followups/public/unsubscribe/:token', async (req, res) => {
  try {
    const result = await engine.unsubscribeByToken(req.params.token);
    if (!result.ok) {
      return res.status(400).type('html').send(unsubscribePageHtml({ ok: false, message: 'This unsubscribe link is invalid or has expired.' }));
    }
    res.type('html').send(unsubscribePageHtml({ ok: true, message: `${result.email} will no longer receive estimate follow-up emails from EC Construction Group.` }));
  } catch (e) {
    console.error('[estimate-followups] public unsubscribe error:', e.message);
    res.status(500).type('html').send(unsubscribePageHtml({ ok: false, message: 'Something went wrong processing your request. Please contact us directly to unsubscribe.' }));
  }
});

module.exports = router;
