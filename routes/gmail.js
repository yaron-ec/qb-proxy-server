/* eslint-disable no-undef */
/**
 * /api/v1/gmail — Railway-owned Gmail READ endpoints (no browser Gmail tokens).
 *
 *   GET  /api/v1/gmail/profile                 -> { emailAddress, messagesTotal, historyId }
 *   GET  /api/v1/gmail/messages?maxResults=N&q=...  -> { messages: [...] }
 *   GET  /api/v1/gmail/messages/:id            -> { id, from, to, subject, date, snippet, fromEmail }
 *
 * All routes require a Railway JWT (requireAuth). Gmail tokens are obtained
 * and refreshed SERVER-SIDE via lib/gmailSender. No Gmail access/refresh
 * token, client id, or client secret is ever returned to the browser.
 * READ-ONLY — no send capability is exposed by this router.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const gmail = require('../lib/gmailSender');

const router = express.Router();

async function gmailFetch(token, path, { query } = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { try { detail = JSON.stringify(await res.json()); } catch (_) {} }
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

function extractEmail(str) {
  const m = String(str || '').match(/[\w.+-]+@[\w-]+\.\w+/);
  return m ? m[0].toLowerCase() : null;
}

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const token = await gmail.refreshAccessToken();
    const profile = await gmailFetch(token, 'profile');
    res.json({ emailAddress: profile.emailAddress, messagesTotal: profile.messagesTotal, historyId: profile.historyId });
  } catch (e) {
    res.status(e instanceof gmail.GmailCredentialsError ? 503 : (e.status || 500)).json({ error: e.message });
  }
});

router.get('/messages', requireAuth, async (req, res) => {
  try {
    const token = await gmail.refreshAccessToken();
    const maxResults = Math.min(parseInt(req.query.maxResults || '20', 10) || 20, 100);
    const q = req.query.q || 'is:inbox';
    const list = await gmailFetch(token, 'messages', { query: { maxResults: String(maxResults), q } });
    const ids = (list.messages || []).map(m => m.id);
    const out = [];
    for (const id of ids) {
      try {
        const msg = await gmailFetch(token, `messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } });
        const payload = msg.payload || {};
        out.push({
          id: msg.id, threadId: msg.threadId,
          from: headerValue(payload, 'From'),
          to: headerValue(payload, 'To'),
          subject: headerValue(payload, 'Subject') || '(no subject)',
          date: headerValue(payload, 'Date'),
          snippet: msg.snippet || '',
        });
      } catch (_) { /* per-message best-effort */ }
    }
    res.json({ messages: out, total: out.length });
  } catch (e) {
    res.status(e instanceof gmail.GmailCredentialsError ? 503 : (e.status || 500)).json({ error: e.message });
  }
});

router.get('/messages/:id', requireAuth, async (req, res) => {
  try {
    const token = await gmail.refreshAccessToken();
    const msg = await gmailFetch(token, `messages/${req.params.id}`, { query: { format: 'full' } });
    const payload = msg.payload || {};
    const from = headerValue(payload, 'From');
    res.json({
      id: msg.id, threadId: msg.threadId,
      from, to: headerValue(payload, 'To'),
      subject: headerValue(payload, 'Subject') || '(no subject)',
      date: headerValue(payload, 'Date'),
      snippet: msg.snippet || '',
      fromEmail: extractEmail(from),
    });
  } catch (e) {
    res.status(e instanceof gmail.GmailCredentialsError ? 503 : (e.status || 500)).json({ error: e.message });
  }
});

module.exports = router;