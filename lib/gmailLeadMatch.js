/**
 * lib/gmailLeadMatch.js — pure Gmail <-> Lead correspondence matching.
 *
 * Deliberately does NOT decide across multiple leads which one a message
 * "really" belongs to — matching is always done for ONE specific lead's
 * own email address, by the caller (routes/leadEmails.js, per-lead-scoped;
 * scripts/reconcileGmailHistory.js, one lead at a time). If two leads
 * legitimately share the same email address, the same message can
 * correctly appear under both — that is not ambiguity, it is the same
 * correspondence genuinely involving both records. This module never
 * guesses a match by display name or subject — only normalized address
 * equality against the exact lead being checked.
 */
'use strict';

// Extracts every email address in a header value (From/To/Cc can contain
// multiple, comma-separated, with display names) — normalized to lowercase.
function extractAllEmails(headerValue) {
  if (!headerValue) return [];
  const matches = String(headerValue).match(/[\w.+-]+@[\w-]+\.\w+/g) || [];
  return [...new Set(matches.map(m => m.toLowerCase()))];
}

function normalizeEmailAddr(v) {
  if (!v) return null;
  const found = extractAllEmails(v);
  return found[0] || null;
}

/**
 * Does this message actually involve the given lead's email address at all
 * (in From, To, or Cc)? The caller's Gmail query is already scoped to the
 * lead's address, so this is a defense-in-depth confirmation, not the
 * primary filter.
 */
function messageInvolvesLead({ from, to, cc }, leadEmail) {
  const normalizedLead = normalizeEmailAddr(leadEmail);
  if (!normalizedLead) return false;
  const all = [...extractAllEmails(from), ...extractAllEmails(to), ...extractAllEmails(cc)];
  return all.includes(normalizedLead);
}

/**
 * classifyDirection — 'inbound' (customer -> company), 'outbound' (company
 * -> customer), or null (the message doesn't clearly involve BOTH the lead
 * and the company mailbox — e.g. neither address appears in From, so this
 * is not genuinely this lead's correspondence with the company).
 *
 * Only ONE company mailbox is integrated today (CLAUDE.md: Gmail is a
 * single hardcoded mailbox) — direction is decided against that one
 * address, not a list of staff addresses.
 */
function classifyDirection({ from, to, cc }, leadEmail, companyEmail) {
  const normalizedLead = normalizeEmailAddr(leadEmail);
  const normalizedCompany = normalizeEmailAddr(companyEmail);
  if (!normalizedLead) return null;

  const fromAddrs = extractAllEmails(from);
  const toAndCcAddrs = [...extractAllEmails(to), ...extractAllEmails(cc)];

  const fromIsCompany = !!normalizedCompany && fromAddrs.includes(normalizedCompany);
  const fromIsLead = fromAddrs.includes(normalizedLead);
  const recipientsIncludeLead = toAndCcAddrs.includes(normalizedLead);
  const recipientsIncludeCompany = !!normalizedCompany && toAndCcAddrs.includes(normalizedCompany);

  if (fromIsCompany && recipientsIncludeLead) return 'outbound';
  if (fromIsLead && recipientsIncludeCompany) return 'inbound';
  // Doesn't clearly show both parties (e.g. a group thread where the lead
  // was only Cc'd and the company wasn't a direct participant) — still
  // attribute a direction from whichever side sent it, rather than
  // discarding real correspondence over an incomplete header set.
  if (fromIsLead) return 'inbound';
  if (fromIsCompany) return 'outbound';
  return null;
}

// The stable idempotency key for a Gmail message, reusing the EXISTING
// activities.external_ref column and its table-wide UNIQUE index
// (db/migrations/2026-19/2026-20) — no new schema needed. Gmail message
// IDs are unique within a mailbox, so prefixing is enough to avoid any
// collision with external_ref values other integrations may set.
function externalRefFor(gmailMessageId) {
  return `gmail:${gmailMessageId}`;
}

function hasAttachment(payload) {
  const parts = (payload && payload.parts) || [];
  return parts.some(p => p && p.filename && p.filename.length > 0);
}

module.exports = {
  extractAllEmails,
  normalizeEmailAddr,
  messageInvolvesLead,
  classifyDirection,
  externalRefFor,
  hasAttachment,
};
