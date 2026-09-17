#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * reconcileGmailHistory.js — historical Gmail <-> Lead correspondence
 * reconciliation, for leads whose email history predates this feature
 * (e.g. a lead with years of prior correspondence that GET
 * /api/v1/leads/:id/emails hasn't been asked to fetch yet, because nobody
 * has opened that Lead's Activity tab since this shipped).
 *
 * Classifies every lead with an email address into:
 *   MATCHED    — at least one Gmail message found and captured this run
 *                (or already captured — see NOTE on idempotency below)
 *   NO_MATCH   — no Gmail message found involving this lead's address
 *   AMBIGUOUS  — this lead's email address is shared by more than one lead
 *                record (both are still reconciled independently and
 *                correctly — see lib/gmailLeadMatch.js's header — this
 *                bucket exists so an operator can SEE how many such cases
 *                exist, not because they are skipped or handled specially)
 *   ERROR      — a per-lead failure (e.g. a transient Gmail API error);
 *                does not stop the run for other leads
 *
 * NEVER calls the Google API to write anything — this only reads Gmail and
 * writes to `activities` via the exact same idempotent
 * INSERT ... ON CONFLICT (external_ref) DO NOTHING path routes/leadEmails.js
 * uses (activities.external_ref's existing table-wide unique index — no new
 * schema). Re-running this script, or a rep separately opening one of these
 * leads' Activity tabs afterward, can never create a duplicate for the same
 * Gmail message.
 *
 * Usage:
 *   node scripts/reconcileGmailHistory.js                  # classify + report only (no writes)
 *   node scripts/reconcileGmailHistory.js --apply           # also perform the idempotent activities upsert
 *   node scripts/reconcileGmailHistory.js --apply --limit=50  # cap how many leads to process this run
 *
 * Requires DATABASE_URL and the same Gmail OAuth configuration
 * lib/gmailSender.js already uses (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN or
 * the integration_credentials store). Refuses to run without DATABASE_URL
 * (never silently reports 0 leads).
 *
 * This is exactly the "implement and test the capability, stop before the
 * unsafe bulk execution boundary" deliverable for historical reconciliation
 * — running --apply against production is a deliberate, separate action an
 * operator takes after reviewing the report-only output, not something this
 * script or any automated process does on its own.
 */
'use strict';

const DO_APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const { classifyDirection, messageInvolvesLead, externalRefFor, hasAttachment } = require('../lib/gmailLeadMatch');

function headerValue(payload, name) {
  const headers = (payload && payload.headers) || [];
  const found = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

async function gmailFetch(token, path, { query } = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  // Same fix as routes/leadEmails.js's gmailFetch: metadataHeaders is a
  // REPEATED Gmail API param, not a comma-joined value — a joined string
  // silently returns zero headers, making every message look header-less.
  if (query) for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, item); }
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gmail ${res.status}: ${String(detail).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function buildLeadEmailQuery(leadEmail) {
  const escaped = leadEmail.replace(/"/g, '');
  return `{from:"${escaped}" to:"${escaped}" cc:"${escaped}"} in:anywhere`;
}

async function reconcileOneLead(pool, gmail, token, companyEmail, lead) {
  const q = buildLeadEmailQuery(lead.email);
  const list = await gmailFetch(token, 'messages', { query: { maxResults: '50', q } });
  const ids = (list.messages || []).map(m => m.id);
  let matchedCount = 0;

  for (const id of ids) {
    const msg = await gmailFetch(token, `messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] } });
    const payload = msg.payload || {};
    const from = headerValue(payload, 'From');
    const to = headerValue(payload, 'To');
    const cc = headerValue(payload, 'Cc');
    if (!messageInvolvesLead({ from, to, cc }, lead.email)) continue;
    const direction = classifyDirection({ from, to, cc }, lead.email, companyEmail);
    if (!direction) continue;
    matchedCount++;

    if (DO_APPLY) {
      const subject = headerValue(payload, 'Subject') || '(no subject)';
      const dateHeader = headerValue(payload, 'Date');
      const messageDate = dateHeader && !Number.isNaN(new Date(dateHeader).getTime()) ? new Date(dateHeader).toISOString() : new Date().toISOString();
      await pool.query(
        `INSERT INTO activities (lead_id, type, content, author, source, metadata, external_ref, created_at)
         VALUES ($1, 'email', $2, $3, 'gmail', $4, $5, $6)
         ON CONFLICT (external_ref) DO NOTHING`,
        [
          lead.id, subject, from, JSON.stringify({
            direction, from, to, cc, snippet: msg.snippet || '', has_attachment: hasAttachment(payload),
            gmail_message_id: msg.id, gmail_thread_id: msg.threadId,
          }),
          externalRefFor(msg.id), messageDate,
        ]
      );
    }
  }
  return matchedCount;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — refusing to run (this must never silently report 0 leads)');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const gmail = require('../lib/gmailSender');
  const companyEmail = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';

  try {
    let token;
    try {
      token = await gmail.refreshAccessToken();
    } catch (e) {
      console.error('Gmail is not reachable — refusing to run (would misreport every lead as NO_MATCH):', e.message);
      process.exit(1);
    }

    const { rows: leads } = await pool.query(
      `SELECT id, first_name, last_name, email FROM leads WHERE email IS NOT NULL AND email != '' ORDER BY created_at ASC`
    );
    const emailCounts = new Map();
    for (const l of leads) emailCounts.set(l.email.toLowerCase(), (emailCounts.get(l.email.toLowerCase()) || 0) + 1);

    const buckets = { MATCHED: [], NO_MATCH: [], AMBIGUOUS: [], ERROR: [] };
    const toProcess = leads.slice(0, LIMIT);

    console.log('=== GMAIL HISTORY RECONCILIATION ===');
    console.log('Mode: ' + (DO_APPLY ? 'APPLY (will idempotently upsert matched messages into activities)' : 'REPORT ONLY (read-only, no writes)'));
    console.log(`Leads with an email on file: ${leads.length}${LIMIT !== Infinity ? ` (processing first ${toProcess.length} due to --limit)` : ''}`);
    console.log('');

    for (const lead of toProcess) {
      const sharedCount = emailCounts.get(lead.email.toLowerCase());
      try {
        const matchedCount = await reconcileOneLead(pool, gmail, token, companyEmail, lead);
        if (sharedCount > 1) buckets.AMBIGUOUS.push({ lead, matchedCount, sharedCount });
        if (matchedCount > 0) buckets.MATCHED.push({ lead, matchedCount });
        else buckets.NO_MATCH.push({ lead });
      } catch (e) {
        buckets.ERROR.push({ lead, error: e.message });
      }
    }

    console.log(`MATCHED:   ${buckets.MATCHED.length} (total messages upserted-or-already-present: ${buckets.MATCHED.reduce((s, r) => s + r.matchedCount, 0)})`);
    console.log(`NO_MATCH:  ${buckets.NO_MATCH.length}`);
    console.log(`AMBIGUOUS: ${buckets.AMBIGUOUS.length} (shared email address across multiple leads — each reconciled independently, not skipped)`);
    console.log(`ERROR:     ${buckets.ERROR.length}`);
    if (buckets.ERROR.length > 0) {
      console.log('');
      console.log('Errors:');
      for (const { lead, error } of buckets.ERROR) console.log(`  ${lead.id} (${lead.first_name} ${lead.last_name}): ${error}`);
    }
    console.log('');
    console.log(DO_APPLY
      ? 'Apply pass complete. Every insert used ON CONFLICT (external_ref) DO NOTHING — re-running this script again is always safe.'
      : 'Read-only pass complete. Re-run with --apply to idempotently persist matched messages as activities (safe to re-run any number of times).');
  } finally {
    await pool.end();
  }
}

module.exports = { reconcileOneLead, buildLeadEmailQuery };

if (require.main === module) {
  main().catch(e => { console.error('[reconcile-gmail-history] FAILED:', e.message); process.exit(1); });
}
