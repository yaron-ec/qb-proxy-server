/* eslint-disable no-undef */
/**
 * estimateFollowupActivityLog — the ONE place a lead-visible activity note
 * is written for an estimate-followup lifecycle event (enroll/pause/resume/
 * stop, including the automatic customer-reply stop).
 *
 * Deliberately a standalone leaf module with no dependency on
 * lib/estimateFollowupEngine.js or lib/estimateFollowupReplyDetection.js —
 * those two files already have a one-way require (engine -> replyDetection)
 * for the fail-closed send gate; giving replyDetection a reason to require
 * engine back (e.g. to call a logging helper defined there) would create a
 * circular require, which Node resolves by handing one side a
 * still-incomplete module.exports depending on load order. Both files
 * import this one instead, so neither ever needs the other's full export
 * surface just to log an activity note.
 *
 * Never throws — a failure to write this note must never roll back or fail
 * the real state transition it is merely documenting (same "best-effort,
 * non-blocking" convention this codebase already uses for every other
 * secondary activity-log write).
 */
'use strict';

const db = require('../db/client');

async function logFollowupActivity(leadId, content, { author = 'system' } = {}) {
  if (!leadId || !content) return;
  try {
    // activities.source has a CHECK constraint limited to
    // ('hubspot','gmail','calendar','manual') — there is no 'system' value.
    // 'manual' is this codebase's own established convention for an
    // automated/system-authored note (see routes/signnowWebhook.js's
    // SignNow-auto-decline note: author 'SignNow (auto)', source 'manual');
    // followed here rather than inventing a different value.
    await db.query(
      `INSERT INTO activities (lead_id, type, content, author, source, created_at) VALUES ($1, 'note', $2, $3, 'manual', NOW())`,
      [leadId, content, author]
    );
  } catch (e) {
    console.warn('[estimate-followup] activity log failed (non-fatal):', e.message);
  }
}

module.exports = { logFollowupActivity };
