/* eslint-disable no-undef */
/**
 * leadStatus — the ONE canonical spelling of each operational lead status.
 *
 * The CRM UI (Kanban, Lead Detail, Settings, Reports, Dashboard, Leads
 * filters) and routes/cronJobs.js all compare leads.status with exact
 * string equality against these values. bookingService used to write
 * 'Appointment Scheduled' (capital S) for a lead created together with its
 * first appointment (Lead Capture, website/Meta bookings), so such leads
 * silently fell out of every "Appt Scheduled" count and filter.
 *
 * Writers canonicalize through canonicalLeadStatus(); readers that receive
 * stored values (routes/leads.js#serializeLead, SQL filters) go through the
 * same function / LEAD_STATUS_VARIANTS so rows stored before the fix are
 * still counted correctly. Stored historical values are NOT rewritten.
 */
'use strict';

const LEAD_STATUS = Object.freeze({
  NEW: 'New',
  NO_ANSWER: 'No answer',
  ANSWERED: 'Answered, no appointment set',
  APPOINTMENT_SCHEDULED: 'Appointment scheduled',
  NO_SHOW: 'No show',
  PROPOSAL_SENT: 'Proposal Sent',
  SOLD: 'Sold',
  LOST: 'Lost',
  DNQ: 'DNQ',
});

const CANONICAL_LEAD_STATUSES = Object.freeze(Object.values(LEAD_STATUS));

const BY_KEY = new Map(CANONICAL_LEAD_STATUSES.map((s) => [s.toLowerCase(), s]));

const key = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Canonical spelling for a known status (case/whitespace-insensitive);
 * any other non-empty value is returned trimmed and otherwise untouched
 * (custom statuses are never invented or dropped). null/'' → null.
 */
function canonicalLeadStatus(status) {
  if (status === undefined || status === null) return status === undefined ? undefined : null;
  const trimmed = String(status).trim();
  if (!trimmed) return null;
  return BY_KEY.get(key(trimmed)) || trimmed;
}

function isCanonicalLeadStatus(status) {
  return CANONICAL_LEAD_STATUSES.includes(status);
}

/** Every stored spelling that means the given canonical status (for SQL IN lists). */
const LEAD_STATUS_VARIANTS = Object.freeze({
  [LEAD_STATUS.APPOINTMENT_SCHEDULED]: ['Appointment scheduled', 'Appointment Scheduled'],
});

module.exports = { LEAD_STATUS, CANONICAL_LEAD_STATUSES, LEAD_STATUS_VARIANTS, canonicalLeadStatus, isCanonicalLeadStatus };
