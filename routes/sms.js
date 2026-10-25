/* eslint-disable no-undef */
/**
 * SMS — Twilio two-way messaging (Railway-native, no Base44).
 *
 *   POST /api/v1/leads/:id/sms           — send an SMS from Lead Detail
 *   GET  /api/v1/leads/:id/sms           — conversation history for a lead
 *   POST /api/v1/sms-webhook/inbound     — Twilio inbound message webhook
 *   POST /api/v1/sms-webhook/status      — Twilio delivery-status callback
 *
 * The two /leads/:id/sms routes require a Railway JWT and reuse
 * routes/leads.js#resolveOwnerScope — the SAME DB-level ownership filter
 * lead CRUD uses (CLAUDE.md: reuse one of the three existing ownership
 * implementations, never invent a fourth) — so SMS visibility/sending
 * follows the exact same admin/manager/office/sales_rep rules as the lead
 * itself. The two webhook routes are Twilio-authenticated only (signature
 * verification, lib/smsClient.js#verifyTwilioSignature), mirroring
 * routes/metaWebhook.js's pattern, and are gated on the `sms` module being
 * enabled (lib/moduleGate.js) the same way meta/website_intake are — a
 * disabled module's webhook responds 404 module_disabled, never a broken
 * 500 or a silently-accepted-and-dropped message.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { requireModuleEnabled } = require('../lib/moduleGate');
const smsService = require('../lib/smsService');
const smsClient = require('../lib/smsClient');

const router = express.Router();

const MAX_BODY_LEN = 1600; // Twilio's own single-message-concatenation ceiling (10 segments of 160 GSM-7 chars)

// webhookBaseUrl() now lives in lib/smsClient.js — see its header comment
// for the October 2026 production incident (CRM_PUBLIC_URL is the
// FRONTEND's URL everywhere else in this codebase; the webhook/signature
// URL needs the BACKEND's own URL instead, via TWILIO_WEBHOOK_BASE_URL).
const webhookBaseUrl = smsClient.webhookBaseUrl;

async function companyName() {
  try {
    const cfg = await require('../lib/companyConfig').getCompanyConfig();
    return cfg.company_name || 'EC Construction Group';
  } catch {
    return 'EC Construction Group';
  }
}

function twiml(message) {
  const body = message ? `<Message>${String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/**
 * A genuinely unexpected failure (DB error, etc. — never an smsService.SmsError,
 * which already carries its own user-safe code/message) must never surface a
 * raw driver/Postgres message to the CRM UI — e.g. the production incident
 * where `new row for relation "sms_messages" violates check constraint
 * "sms_messages_status_check"` reached the browser verbatim via `e.message`.
 * Full detail (message, code, stack) goes to server logs only; the client
 * gets one generic, actionable message.
 */
function logAndRespondUnexpectedError(e, res, context) {
  console.error(`[sms] ${context} error:`, { message: e.message, code: e.code, stack: e.stack });
  res.status(500).json({ error: 'unexpected_error', message: 'Something went wrong sending/loading this message. Please try again, or contact support if it keeps happening.' });
}

// ── POST /api/v1/leads/:id/sms — send ───────────────────────────────────────
router.post('/leads/:id/sms', requireAuth, requireModuleEnabled('sms'), async (req, res) => {
  try {
    const { resolveOwnerScope } = require('./leads');
    const { query } = require('../db/client');
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    const leadR = await query('SELECT id, owner_id FROM leads WHERE id = $1', [req.params.id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > MAX_BODY_LEN) return res.status(400).json({ error: `body exceeds ${MAX_BODY_LEN} characters` });

    const statusCallbackUrl = webhookBaseUrl() ? `${webhookBaseUrl()}/api/v1/sms-webhook/status` : undefined;
    const row = await smsService.sendSms({
      leadId: leadR.rows[0].id, body, sentBy: req.user.email, statusCallbackUrl,
    });
    res.json({ message: row });
  } catch (e) {
    if (e instanceof smsService.SmsError) {
      const status = { lead_not_found: 404, no_phone: 422, invalid_phone: 422, recipient_opted_out: 422, no_consent: 422, quiet_hours: 422, twilio_not_configured: 503 }[e.code] || 502;
      return res.status(status).json({ error: e.code, message: e.message, sms: e.messageRow || null });
    }
    logAndRespondUnexpectedError(e, res, 'send');
  }
});

// ── GET /api/v1/leads/:id/sms — conversation history ────────────────────────
router.get('/leads/:id/sms', requireAuth, requireModuleEnabled('sms'), async (req, res) => {
  try {
    const { resolveOwnerScope } = require('./leads');
    const { query } = require('../db/client');
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    const leadR = await query('SELECT id, owner_id FROM leads WHERE id = $1', [req.params.id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const items = await smsService.getConversation(leadR.rows[0].id);
    res.json({ items });
  } catch (e) {
    logAndRespondUnexpectedError(e, res, 'history');
  }
});

// ── Twilio webhooks (unauthenticated — signature-verified instead) ─────────
const webhookRouter = express.Router();
webhookRouter.use(requireModuleEnabled('sms'));
webhookRouter.use(express.urlencoded({ extended: false }));

// Returns { ok, url } — `url` is always returned (even on failure) so a
// rejection can be recorded with the EXACT URL our server expected Twilio to
// have signed against (see lib/smsClient.js#webhookBaseUrl's header for the
// October 2026 incident this directly diagnoses: that URL should be
// byte-for-byte identical to the webhook URL configured in Twilio Console).
function verifyRequest(req, path) {
  const url = `${webhookBaseUrl()}${path}`;
  const signature = req.headers['x-twilio-signature'];
  return { ok: smsClient.verifyTwilioSignature(url, req.body || {}, signature), url };
}

webhookRouter.post('/inbound', async (req, res) => {
  try {
    const verification = verifyRequest(req, '/api/v1/sms-webhook/inbound');
    if (!verification.ok) {
      console.warn('[sms-webhook] inbound signature verification failed', { expected_url: verification.url, host_header: req.headers.host });
      await smsService.recordWebhookRejection({
        path: 'inbound', computedUrl: verification.url, hostHeader: req.headers.host,
        hasSignatureHeader: !!req.headers['x-twilio-signature'],
        messageSid: req.body && req.body.MessageSid, fromNumber: req.body && req.body.From,
      });
      return res.status(401).send('signature_verification_failed');
    }
    const { MessageSid, From, To, Body } = req.body || {};
    if (!MessageSid || !From) return res.status(400).send('missing_fields');

    const result = await smsService.handleInboundMessage({ messageSid: MessageSid, from: From, to: To, body: Body || '' });

    // Rep notification + mandatory Yaron forward — ONLY for a genuinely new,
    // ordinary (non-keyword) message. A redelivered webhook (result.duplicate)
    // or a STOP/START/HELP keyword never re-fires these (keyword messages are
    // already fully handled by the TwiML auto-reply + opt-out recording
    // above/below — forwarding "STOP" as if it were a customer inquiry would
    // be noise, not signal). AWAITED (not fire-and-forget): Twilio tolerates
    // several seconds of webhook latency, and awaiting here is what makes
    // "one notification per unique inbound message" and "no duplicate
    // forwarding on retry" an actual guarantee rather than a race — a
    // redelivered webhook must see result.duplicate=true only AFTER the
    // first delivery's side effects have actually run, and a response sent
    // before they complete would let two near-simultaneous deliveries both
    // read "not yet duplicate" and both notify/forward. Failures inside are
    // still fully non-fatal to the TwiML response (each catches its own
    // errors; see lib/smsReplyNotify.js).
    if (!result.duplicate && !result.keyword) {
      const smsReplyNotify = require('../lib/smsReplyNotify');
      const crmPublicUrl = process.env.CRM_PUBLIC_URL || '';
      let repName = null, customerName = null;
      if (result.match && result.match.leadId) {
        await smsReplyNotify.notifyAssignedRep({ leadId: result.match.leadId, body: Body || '', messageSid: MessageSid, crmPublicUrl }).catch(() => {});
        const row = await smsReplyNotify.resolveLeadAndOwner(result.match.leadId).catch(() => null);
        if (row) {
          repName = row.owner_name || null;
          customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || null;
        }
      } else {
        await smsReplyNotify.notifyUnmatchedForReview({ body: Body || '', messageSid: MessageSid, fromNumber: From, ambiguous: !!(result.match && result.match.ambiguous), candidateLeadIds: result.match && result.match.candidateIds }).catch(() => {});
      }
      // Mandatory per spec, regardless of which rep (if any) owns the lead.
      await smsReplyNotify.forwardToYaronBestEffort({ customerName, repName, body: Body || '' }).catch(() => {});
    }

    if (result.keyword === 'STOP') {
      const name = await companyName();
      return res.type('text/xml').send(twiml(`${name}: You have been unsubscribed and will not receive further SMS messages. Reply START to resubscribe.`));
    }
    if (result.keyword === 'START') {
      const name = await companyName();
      return res.type('text/xml').send(twiml(`${name}: You are resubscribed. Reply STOP to unsubscribe at any time, HELP for help.`));
    }
    if (result.keyword === 'HELP') {
      const name = await companyName();
      return res.type('text/xml').send(twiml(`${name}: For help, call us. Reply STOP to unsubscribe. Msg & data rates may apply.`));
    }
    // Ordinary message — no auto-reply (empty TwiML), always 200 so Twilio never retries.
    return res.type('text/xml').send(twiml());
  } catch (e) {
    console.error('[sms-webhook] inbound error:', e.message);
    // Always 200 to Twilio even on our own failure — a 5xx here causes Twilio
    // to retry the SAME webhook repeatedly, and handleInboundMessage is
    // idempotent on MessageSid, so a true transient DB error is better
    // surfaced in logs than turned into a customer-visible delivery problem.
    return res.type('text/xml').send(twiml());
  }
});

webhookRouter.post('/status', async (req, res) => {
  try {
    const verification = verifyRequest(req, '/api/v1/sms-webhook/status');
    if (!verification.ok) {
      console.warn('[sms-webhook] status signature verification failed', { expected_url: verification.url, host_header: req.headers.host });
      await smsService.recordWebhookRejection({
        path: 'status', computedUrl: verification.url, hostHeader: req.headers.host,
        hasSignatureHeader: !!req.headers['x-twilio-signature'],
        messageSid: req.body && req.body.MessageSid, fromNumber: null,
      });
      return res.status(401).send('signature_verification_failed');
    }
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body || {};
    if (!MessageSid || !MessageStatus) return res.status(400).send('missing_fields');
    await smsService.handleStatusCallback({ messageSid: MessageSid, status: MessageStatus, errorCode: ErrorCode, errorMessage: ErrorMessage });
    res.status(204).end();
  } catch (e) {
    console.error('[sms-webhook] status error:', e.message);
    res.status(204).end();
  }
});

module.exports = { router, webhookRouter };
