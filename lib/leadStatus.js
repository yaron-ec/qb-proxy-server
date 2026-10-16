/* eslint-disable no-undef */
/**
 * leadStatus — canonical "terminal lost" transition detection.
 *
 * ROOT-CAUSE NOTE (production bug, lead "Rita Wilcher"): this module
 * originally only recognized the literal string 'Closed Lost'. That literal
 * turns out to be unreachable through any live, current UI status control —
 * it does not appear in crm-frontend/src/lib/design-system.js#STATUS_STYLES
 * (that file's own header calls it "the one canonical source" for status
 * values), LeadDetailModern.jsx's STATUSES dropdown, or KanbanBoard.jsx's
 * STATUS_COLUMNS. The status a user actually sets when a lead is dead is
 * 'Lost'. Because of that gap, the original Closed-Lost-only fix never
 * fired for the overwhelmingly common real-world case, so a lead marked
 * Lost kept its stale appointment, Driving/Travel Time blocks, and
 * Done/Reschedule actions — exactly the Rita Wilcher symptom.
 *
 * This module now recognizes every TERMINAL_LOST_STATUSES value as
 * equivalent for this purpose, matching existing precedent already present
 * elsewhere in this codebase treating these as the same "lead is dead, stop
 * acting on it" bucket (crm-frontend/src/pages/MobileDayView.jsx's
 * `excluded`/`excludedForOverdue` arrays, LeadBreakdown.jsx's 'closed-lost'
 * bucket listing both 'Lost' and 'Closed Lost',
 * scripts/reconcileGoogleContactsLive.js's exclusion list). Deliberately
 * excludes:
 *   - 'Sold' / 'Won' — positive outcomes; a post-sale appointment can be
 *     legitimate and must never be auto-cancelled by this logic.
 *   - 'Duplicate' — owned by the separate lead-merge subsystem
 *     (scripts/auditAppointmentFollowUp.js and friends); folding it in here
 *     risks conflicting with that subsystem's own invariants.
 *   - 'Archived' / 'Closed' — not confirmed reachable via any live UI
 *     control today; tracked as an open item (see CLAUDE.md) rather than
 *     guessed into this set.
 *
 * A lead is "entering" a terminal lost status only on the actual edge — the
 * write that changes status FROM a non-terminal value TO a terminal one. An
 * edit that leaves an already-terminal lead's status unchanged (e.g.
 * updating notes) is NOT a re-entry: it must not re-fire appointment
 * cancellation / activity logging on every subsequent edit. A write that
 * moves BETWEEN two terminal statuses (e.g. 'Lost' -> 'DNQ') is also not a
 * fresh entry — by the time a lead reached either, the first transition
 * (or the remediation script, for pre-existing data) already handled
 * cleanup. A write that changes status AWAY FROM a terminal status
 * (reopening) is also not an entry, and intentionally has no special
 * handling here — reopening never automatically restores a cancelled
 * appointment or a cleared follow-up (see routes/leads.js); the user must
 * explicitly reschedule.
 */
'use strict';

// Kept for backward compatibility with any existing reference to the exact
// literal this module originally special-cased.
const CLOSED_LOST_STATUS = 'Closed Lost';

const TERMINAL_LOST_STATUSES = ['Lost', 'Closed Lost', 'DNQ', 'Cancelled'];
const TERMINAL_LOST_STATUS_SET = new Set(TERMINAL_LOST_STATUSES);

function isTerminalLostStatus(status) {
  return TERMINAL_LOST_STATUS_SET.has(status);
}

function isEnteringTerminalLostStatus(oldStatus, newStatus) {
  return isTerminalLostStatus(newStatus) && !isTerminalLostStatus(oldStatus);
}

// Deprecated name, kept so any existing caller/import keeps working exactly
// as before — now backed by the generalized terminal-lost-status set rather
// than the single 'Closed Lost' literal.
function isEnteringClosedLost(oldStatus, newStatus) {
  return isEnteringTerminalLostStatus(oldStatus, newStatus);
}

module.exports = {
  CLOSED_LOST_STATUS,
  TERMINAL_LOST_STATUSES,
  isTerminalLostStatus,
  isEnteringTerminalLostStatus,
  isEnteringClosedLost,
};
