/* eslint-disable no-undef */
/**
 * leadStatus — canonical "Closed Lost" transition detection.
 *
 * A lead is "entering Closed Lost" only on the actual edge — the write that
 * changes status FROM something else TO 'Closed Lost'. An edit that leaves
 * an already-Closed-Lost lead's status unchanged (e.g. updating notes) is
 * NOT a re-entry: it must not re-fire appointment cancellation / activity
 * logging on every subsequent edit. A write that changes status AWAY FROM
 * 'Closed Lost' (reopening) is also not an entry, and intentionally has no
 * special handling here — reopening never automatically restores a
 * cancelled appointment or a cleared follow-up (see routes/leads.js); the
 * user must explicitly reschedule.
 */
'use strict';

const CLOSED_LOST_STATUS = 'Closed Lost';

function isEnteringClosedLost(oldStatus, newStatus) {
  return newStatus === CLOSED_LOST_STATUS && oldStatus !== CLOSED_LOST_STATUS;
}

module.exports = { CLOSED_LOST_STATUS, isEnteringClosedLost };
