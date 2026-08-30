/* eslint-disable no-undef */
/**
 * Public, unauthenticated customer-action router: /r/*
 *
 * Security:
 *  - Opaque tokens (32 random bytes); only SHA-256 stored; lookup by hash.
 *  - 30-day expiry; expired → branded expired page.
 *  - Appointment-fingerprint change detection: if date/time/type/rep changed
 *    since the email was generated, the link shows a branded "changed" page
 *    and never acts on or reveals the new appointment/rep.
 *  - One-time CSRF nonce on every POST.
 *  - Per-IP in-memory rate limiting.
 *  - Strict security headers, no-store caching, CSP frame-ancestors 'none'.
 *  - Generic invalid-token responses (no enumeration, no Lead existence leak).
 *  - IP taken from the socket unless REMINDER_TRUST_PROXY=true.
 *  - No raw tokens / hashes / PII / secrets in logs.
 *
 * Confirm/reschedule POSTs commit the customer action + enqueue a Railway
 * notification in ONE transaction; Gmail delivery runs in a separate flush
 * after commit, so a Gmail failure never loses the action.
 *
 * Zero Base44. All data from Railway PostgreSQL (reminder_leads + token row).
 */
'use strict';

const express = require('express');
const db = require('../db/client');
const tokenStore = require('./actionTokenStore');
const actions = require('./reminderActions');
const notifications = require('./reminderNotifications');
const pages = require('./reminderPages');
const repDir = require('./repDirectory');
const time = require('./reminderTime');

const router = express.Router();
router.use(express.urlencoded({ extended: true, limit: '8kb' }));

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const _hits = new Map();

function clientIp(req) {
  if (process.env.REMINDER_TRUST_PROXY === 'true') {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || null;
}

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (_hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  _hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

function setHeaders(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https://crm.ecconstructiongroup.com; frame-ancestors 'none'; base-uri 'none'");
}

function html(res, page, status) {
  setHeaders(res);
  res.status(status || 200).type('html').send(page);
}

const invalid = (res) => html(res, pages.invalidPage(), 400);
const expired = (res) => html(res, pages.expiredPage(), 410);
const changed = (res) => html(res, pages.appointmentChangedPage(), 409);

router.use((req, res, next) => {
  setHeaders(res);
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).type('text').send('Too Many Requests');
  next();
});

async function getLead(leadId) {
  const { rows } = await db.query('SELECT * FROM reminder_leads WHERE id=$1', [leadId]);
  return rows[0] || null;
}

function repFromSnapshot(tok) {
  const s = tok.snapshot || {};
  return {
    name: s.repName || 'EC Construction Group',
    directPhone: s.repPhone || repDir.OFFICE_PHONE,
    email: s.repEmail || repDir.OFFICE_EMAIL,
    officePhone: s.officePhone || repDir.OFFICE_PHONE,
    officeEmail: s.officeEmail || repDir.OFFICE_EMAIL,
  };
}

function apptFromSnapshot(tok) {
  const s = tok.snapshot || {};
  return { date: s.apptDate || '', time: s.apptTime || '', address: s.address || '', type: s.apptType || '' };
}

async function currentFingerprint(lead, leadId) {
  if (!lead) return null;
  const p = time.appointmentParts(lead);
  return tokenStore.fingerprint({ leadId, date: p.date, time: p.time, type: p.type, repEmail: repDir.repEmailForLead(lead) });
}

async function resolveAndCheck(res, rawToken) {
  const tok = await tokenStore.lookupToken(db, rawToken);
  if (!tok) { invalid(res); return null; }
  if (new Date(tok.expires_at).getTime() <= Date.now()) { expired(res); return null; }
  const lead = await getLead(tok.lead_id);
  const cur = await currentFingerprint(lead, tok.lead_id);
  if (cur !== tok.appointment_fingerprint) { changed(res); return null; }
  return { tok, lead };
}

// ── Confirm ──────────────────────────────────────────────────────────────────

router.get('/confirm/:token', async (req, res) => {
  await db.ensureSchema();
  const ctx = await resolveAndCheck(res, req.params.token);
  if (!ctx) return;
  const { tok } = ctx;
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  await actions.recordEvent(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, actionType: 'confirm', eventType: 'page_opened', ip, userAgent: ua }).catch(() => {});
  const rep = repFromSnapshot(tok);
  const appt = apptFromSnapshot(tok);
  if (await actions.isConfirmed(db, tok.appointment_fingerprint)) {
    return html(res, pages.alreadyConfirmedPage({ rep, appt, rawToken: req.params.token }));
  }
  const nonce = await actions.issueNonce(db, tok.token_hash).catch(() => null);
  html(res, pages.confirmFormPage({ rep, appt, token: req.params.token, nonce }));
});

router.post('/confirm/:token', async (req, res) => {
  await db.ensureSchema();
  const ctx = await resolveAndCheck(res, req.params.token);
  if (!ctx) return;
  const { tok } = ctx;
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  const nonceOk = await actions.consumeNonce(db, req.body && req.body.nonce, tok.token_hash).catch(() => false);
  if (!nonceOk) return invalid(res); // CSRF / replay → generic invalid (no leak)
  const s = tok.snapshot || {};
  const notif = {
    assignedRep: s.repName, assignedRepEmail: s.repEmail,
    recipientEmails: s.repEmail || repDir.OFFICE_EMAIL,
    subject: `✓ Appointment Confirmed — ${s.clientFirstName || ''} ${s.clientLastName || ''}`.trim(),
    body: notifyShell(`Appointment Confirmed by Customer`, [
      `Customer: ${s.clientFirstName || ''} ${s.clientLastName || ''}`.trim(),
      `Date: ${s.apptDate || ''}`, `Time: ${s.apptTime || ''}`,
      s.address ? `Address: ${s.address}` : null,
      `Representative: ${s.repName || ''}`,
    ], 'The customer confirmed their appointment via the reminder email.'),
  };
  const { first } = await actions.completeConfirm(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, ip, userAgent: ua, notification: notif });
  if (first && process.env.REMINDER_DRY_RUN !== 'true') { try { await notifications.flushPendingNotifications(db); } catch (e) { /* best-effort */ } }
  const rep = repFromSnapshot(tok); const appt = apptFromSnapshot(tok);
  html(res, first ? pages.confirmedPage({ rep, appt, rawToken: req.params.token }) : pages.alreadyConfirmedPage({ rep, appt, rawToken: req.params.token }));
});

// ── Reschedule ───────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

router.get('/reschedule/:token', async (req, res) => {
  await db.ensureSchema();
  const ctx = await resolveAndCheck(res, req.params.token);
  if (!ctx) return;
  const { tok } = ctx;
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  await actions.recordEvent(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, actionType: 'reschedule', eventType: 'page_opened', ip, userAgent: ua }).catch(() => {});
  const nonce = await actions.issueNonce(db, tok.token_hash).catch(() => null);
  html(res, pages.rescheduleFormPage({ rep: repFromSnapshot(tok), appt: apptFromSnapshot(tok), token: req.params.token, nonce }));
});

router.post('/reschedule/:token', async (req, res) => {
  await db.ensureSchema();
  const ctx = await resolveAndCheck(res, req.params.token);
  if (!ctx) return;
  const { tok } = ctx;
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  const nonceOk = await actions.consumeNonce(db, req.body && req.body.nonce, tok.token_hash).catch(() => false);
  if (!nonceOk) return invalid(res);
  const date = (req.body && req.body.date || '').trim();
  const timeVal = (req.body && req.body.time || '').trim();
  const note = (req.body && req.body.note || '').trim();
  if (note.length > 500) {
    return html(res, pages.rescheduleFormPage({ rep: repFromSnapshot(tok), appt: apptFromSnapshot(tok), token: req.params.token, nonce: '', error: 'Note must be 500 characters or fewer.' }), 400);
  }
  if (!DATE_RE.test(date) || !TIME_RE.test(timeVal)) {
    return html(res, pages.rescheduleFormPage({ rep: repFromSnapshot(tok), appt: apptFromSnapshot(tok), token: req.params.token, nonce: '', error: 'Please choose a valid date and time.' }), 400);
  }
  const noteHash = actions.sha(note || '');
  const s = tok.snapshot || {};
  const notif = {
    assignedRep: s.repName, assignedRepEmail: s.repEmail,
    recipientEmails: notifications.MICHELLE_EMAIL,
    subject: `📅 Reschedule Request — ${s.clientFirstName || ''} ${s.clientLastName || ''}`.trim(),
    body: notifyShell(`Reschedule Request`, [
      `Customer: ${s.clientFirstName || ''} ${s.clientLastName || ''}`.trim(),
      `Requested: ${date} at ${timeVal}`,
      `Current appointment: ${s.apptDate || ''} at ${s.apptTime || ''}`,
      `Representative: ${s.repName || ''}`,
      note ? `Customer note: ${note}` : null,
    ], 'The appointment was not changed automatically. Contact the customer to confirm the new time.'),
  };
  const { first } = await actions.completeReschedule(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, requestedDate: date, requestedTime: timeVal, note, noteHash, ip, userAgent: ua, notification: notif });
  if (first && process.env.REMINDER_DRY_RUN !== 'true') { try { await notifications.flushPendingNotifications(db); } catch (e) { /* best-effort */ } }
  const rep = repFromSnapshot(tok); const appt = apptFromSnapshot(tok);
  html(res, first ? pages.rescheduleReceivedPage({ rep, appt, rawToken: req.params.token, requestedDate: date, requestedTime: timeVal }) : pages.alreadySubmittedPage({ rep, appt, rawToken: req.params.token, requestedDate: date, requestedTime: timeVal }));
});

// ── Contact ──────────────────────────────────────────────────────────────────

router.get('/contact/:token', async (req, res) => {
  await db.ensureSchema();
  const tok = await tokenStore.lookupToken(db, req.params.token);
  if (!tok) return invalid(res);
  if (new Date(tok.expires_at).getTime() <= Date.now()) return expired(res);
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  await actions.recordEvent(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, actionType: 'contact', eventType: 'page_opened', ip, userAgent: ua }).catch(() => {});
  html(res, pages.contactPage({ rep: repFromSnapshot(tok), rawToken: req.params.token }));
});

// ── Click tracking → tel:/mailto: redirect ───────────────────────────────────

const CLICK_BUTTONS = ['call_rep', 'email_rep', 'call_office', 'email_office'];

router.get('/click/:token', async (req, res) => {
  await db.ensureSchema();
  const tok = await tokenStore.lookupToken(db, req.params.token);
  if (!tok) return invalid(res);
  if (new Date(tok.expires_at).getTime() <= Date.now()) return expired(res);
  const btn = req.query.btn;
  if (!CLICK_BUTTONS.includes(btn)) return invalid(res);
  const { ip, ua } = { ip: clientIp(req), ua: req.headers['user-agent'] || null };
  await actions.recordEvent(db, { tokenHash: tok.token_hash, leadId: tok.lead_id, apptFp: tok.appointment_fingerprint, actionType: 'contact', eventType: 'button_clicked', status: 'completed', note: btn, ip, userAgent: ua }).catch(() => {});
  const rep = repFromSnapshot(tok);
  let target = null;
  if (btn === 'call_rep') target = `tel:${repDir.telDigits(rep.directPhone)}`;
  else if (btn === 'email_rep') target = `mailto:${rep.email}`;
  else if (btn === 'call_office') target = `tel:${repDir.telDigits(rep.officePhone)}`;
  else if (btn === 'email_office') target = `mailto:${rep.officeEmail}`;
  if (!target) return invalid(res);
  res.redirect(302, target);
});

function notifyShell(title, lines, footer) {
  const rows = lines.filter(Boolean).map((l) => `<p style="margin:4px 0;">${l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</p>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#EEF1F7;padding:32px 16px;margin:0;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
      <div style="background:#0B2D5C;padding:24px;color:#C9A227;font-weight:700;text-align:center;">EC Construction Group</div>
      <div style="padding:28px 24px;color:#1A1A2E;line-height:1.6;font-size:15px;">
        <h2 style="color:#0B2D5C;margin:0 0 12px;">${title}</h2>${rows}
        <p style="color:#6B7280;margin-top:16px;font-size:13px;">${footer}</p>
      </div>
    </div></body></html>`;
}

module.exports = router;