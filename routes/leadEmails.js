/* eslint-disable no-undef */
/**
 * /api/v1/leads/:id/emails — lead-scoped Gmail correspondence.
 *
 *   GET /api/v1/leads/:id/emails -> { items: [...] }
 *
 * Unlike routes/gmail.js (admin-only, arbitrary whole-mailbox search), this
 * NEVER accepts a caller-supplied Gmail query. It builds one safe query,
 * scoped to exactly this lead's own email address, and is authorized via
 * the canonical checkLeadScope layer (routes/activities.js's own pattern) —
 * a sales_rep can only pull correspondence for a lead they actually own.
 *
 * Idempotency: reuses the EXISTING activities.external_ref column and its
 * table-wide UNIQUE index (db/migrations/2026-19/2026-20) — no new schema.
 * Each Gmail message becomes external_ref = 'gmail:<messageId>'; a repeat
 * fetch, a worker retry, or a Gmail history replay all resolve to the same
 * external_ref, so INSERT ... ON CONFLICT (external_ref) DO NOTHING can
 * never create a duplicate activity for the same message.
 *
 * created_at is set to the REAL Gmail message timestamp (the Date header),
 * not the moment this sync ran — matching how lib/dealTimeline.js already
 * treats activities.created_at as the event's own instant, not a row-
 * insertion audit field, and satisfying the "use the actual Gmail
 * timestamp, not a sync timestamp" requirement.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { checkLeadScope } = require('../lib/recordAccess');
const gmail = require('../lib/gmailSender');
const { classifyDirection, messageInvolvesLead, externalRefFor, hasAttachment } = require('../lib/gmailLeadMatch');

const router = express.Router();
router.use(requireAuth);

const COMPANY_EMAIL = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
const MAX_MESSAGES = 50;
const MAX_PAGES = 4; // up to 200 messages/lead per request — bounded, not unbounded
const MAX_TOTAL_MESSAGES = 200;

async function gmailFetch(token, path, { query: q } = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  // Gmail API repeatable params (e.g. metadataHeaders) must appear as the
  // SAME query key repeated once per value (?metadataHeaders=From&metadataHeaders=To&...),
  // never as one comma-joined value — Gmail treats a joined string as a
  // single (nonexistent) header name and silently returns zero headers,
  // which then makes every message look like it has no From/To/Cc at all.
  if (q) for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, item); }
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* best-effort */ }
    if (res.status === 401) throw new gmail.GmailCredentialsError(`Gmail read 401: ${String(detail).slice(0, 200)}`);
    const err = new Error(`Gmail read ${res.status}: ${String(detail).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  try { return await res.json(); } catch { return {}; }
}

function headerValue(payload, name) {
  const headers = (payload && payload.headers) || [];
  const found = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function serializeActivity(row) {
  if (!row) return null;
  return {
    id: row.id, external_ref: row.external_ref, lead_id: row.lead_id, type: row.type,
    content: row.content, author: row.author, source: row.source, metadata: row.metadata || {},
    timestamp: row.created_at, created_date: row.created_at, updated_date: row.updated_at,
  };
}

// Builds a Gmail search scoped to exactly this lead's own address — never a
// caller-supplied `q`. `in:anywhere` includes Sent (outbound) as well as
// Inbox (inbound), matching the requirement to capture both directions.
function buildLeadEmailQuery(leadEmail) {
  const escaped = leadEmail.replace(/"/g, '');
  return `{from:"${escaped}" to:"${escaped}" cc:"${escaped}"} in:anywhere`;
}

router.get('/:id/emails', async (req, res) => {
  try {
    const leadId = req.params.id;
    const access = await checkLeadScope(req.user, leadId);
    if (!access.allowed) {
      const status = access.reason === 'lead_not_found' ? 404 : 403;
      return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
    }

    const { rows: leadRows } = await query('SELECT id, email FROM leads WHERE id = $1', [leadId]);
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: 'not_found' });

    // gmailStatus is surfaced to the UI (Lead Detail's Activity feed) so a
    // Gmail read failure is VISIBLE on the page itself — never just a
    // silently-empty Emails filter. 'ok' = live Gmail read succeeded this
    // request; 'no_email_on_file' = nothing to search for; 'unavailable' =
    // Gmail could not be reached/authorized this request (gmailError holds
    // the raw message — e.g. a Google OAuth scope/authorization error —
    // for diagnosis without server log access).
    let gmailStatus = 'ok';
    let gmailError = null;
    // Safe, non-secret diagnostics — the query is scoped to only this
    // lead's own address (nothing private about another mailbox), and the
    // counts let a real production check distinguish "Gmail read succeeded,
    // 0 matching messages" from "messages found but discarded by matching"
    // from "matched but never reached the frontend" — never expose tokens,
    // headers, snippets, or any other mailbox's data here.
    let gmailQuery = null;
    let gmailMessagesFound = 0;
    let gmailMessagesMatched = 0;

    // No email on file — nothing to search for. Return whatever gmail-
    // sourced activities already exist (e.g. from a prior sync before the
    // email was cleared) rather than erroring.
    if (!lead.email) {
      gmailStatus = 'no_email_on_file';
    } else {
      try {
        const token = await gmail.refreshAccessToken();
        const q = buildLeadEmailQuery(lead.email);
        gmailQuery = q;

        // Paginate: a lead with substantial history can have more than one
        // page of matching messages. Bounded (not unbounded) to avoid an
        // unbounded number of Gmail API calls on one request.
        const ids = [];
        let pageToken;
        let pages = 0;
        do {
          const list = await gmailFetch(token, 'messages', { query: { maxResults: String(MAX_MESSAGES), q, ...(pageToken ? { pageToken } : {}) } });
          ids.push(...(list.messages || []).map(m => m.id));
          pageToken = list.nextPageToken;
          pages++;
        } while (pageToken && pages < MAX_PAGES && ids.length < MAX_TOTAL_MESSAGES);
        gmailMessagesFound = ids.length;

        for (const id of ids) {
          try {
            const msg = await gmailFetch(token, `messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] } });
            const payload = msg.payload || {};
            const from = headerValue(payload, 'From');
            const to = headerValue(payload, 'To');
            const cc = headerValue(payload, 'Cc');
            if (!messageInvolvesLead({ from, to, cc }, lead.email)) continue;
            const direction = classifyDirection({ from, to, cc }, lead.email, COMPANY_EMAIL);
            if (!direction) continue;
            gmailMessagesMatched++;

            const subject = headerValue(payload, 'Subject') || '(no subject)';
            const dateHeader = headerValue(payload, 'Date');
            const messageDate = dateHeader && !Number.isNaN(new Date(dateHeader).getTime()) ? new Date(dateHeader).toISOString() : new Date().toISOString();

            await query(
              `INSERT INTO activities (lead_id, type, content, author, source, metadata, external_ref, created_at)
               VALUES ($1, 'email', $2, $3, 'gmail', $4, $5, $6)
               ON CONFLICT (external_ref) DO NOTHING`,
              [
                leadId, subject, from, JSON.stringify({
                  direction, from, to, cc,
                  snippet: msg.snippet || '',
                  has_attachment: hasAttachment(payload),
                  gmail_message_id: msg.id,
                  gmail_thread_id: msg.threadId,
                }),
                externalRefFor(msg.id), messageDate,
              ]
            );
          } catch (perMessageErr) {
            console.warn('[lead-emails] per-message sync failed (best-effort):', perMessageErr.message);
          }
        }
      } catch (gmailErr) {
        // Gmail unavailable/misconfigured is non-fatal here — still return
        // whatever email activity already exists for this lead — but the
        // failure itself must not be silently swallowed: surface it so a
        // real production check (open this Lead's Activity tab) shows the
        // exact reason instead of an indistinguishable "no history".
        gmailStatus = 'unavailable';
        gmailError = gmailErr.message;
        console.warn('[lead-emails] Gmail fetch failed (returning existing activity only):', gmailErr.message);
      }
    }

    const { rows } = await query(
      `SELECT * FROM activities WHERE lead_id = $1 AND type = 'email' ORDER BY created_at DESC LIMIT 200`,
      [leadId]
    );
    res.json({
      items: rows.map(serializeActivity),
      gmail_status: gmailStatus,
      gmail_error: gmailError,
      gmail_query: gmailQuery,
      gmail_messages_found: gmailMessagesFound,
      gmail_messages_matched: gmailMessagesMatched,
    });
  } catch (e) {
    console.error('[lead-emails] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
