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
 * classifyDirection — 'inbound' (arrived at/involves the connected company
 * mailbox) or 'outbound' (the connected company mailbox itself sent it), or
 * null only if the lead's address can't be normalized at all.
 *
 * The caller (routes/leadEmails.js, scripts/reconcileGmailHistory.js)
 * always calls this AFTER messageInvolvesLead() has already confirmed the
 * lead's address appears somewhere in From/To/Cc — so by the time this
 * runs, the only real question is which side sent it. fromIsCompany is the
 * only way to positively identify an OUTBOUND message (this Gmail account
 * only ever authenticates as the one connected company mailbox — CLAUDE.md:
 * a single hardcoded mailbox, never a list of staff addresses). Every other
 * case (the lead sent it directly, or the lead was only Cc'd on a message
 * from a third party/colleague that nonetheless reached this mailbox) is
 * 'inbound' relative to the company — it was never SENT by the connected
 * account, so from that account's perspective it arrived. Production defect
 * this fixes: a message where a colleague (not the lead, not the company
 * mailbox) emailed someone else and merely Cc'd the lead was silently
 * discarded (returned null) instead of being shown as inbound
 * correspondence involving the lead.
 */
function classifyDirection({ from, to, cc }, leadEmail, companyEmail) {
  const normalizedLead = normalizeEmailAddr(leadEmail);
  if (!normalizedLead) return null;

  const fromAddrs = extractAllEmails(from);
  const toAndCcAddrs = [...extractAllEmails(to), ...extractAllEmails(cc)];
  // Defense-in-depth (mirrors messageInvolvesLead): never fabricate a
  // direction for a message the lead isn't actually part of.
  if (!fromAddrs.includes(normalizedLead) && !toAndCcAddrs.includes(normalizedLead)) return null;

  const normalizedCompany = normalizeEmailAddr(companyEmail);
  const fromIsCompany = !!normalizedCompany && fromAddrs.includes(normalizedCompany);
  return fromIsCompany ? 'outbound' : 'inbound';
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
