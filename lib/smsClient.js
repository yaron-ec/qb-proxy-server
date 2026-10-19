/* eslint-disable no-undef */
/**
 * smsClient — raw Twilio REST access for customer-facing SMS (Railway-native,
 * no Twilio Node SDK dependency — mirrors the fetch-based style already
 * established by lib/reminderAlerts.js's internal-alert SMS and
 * lib/systemHealthChecks.js#checkTwilio's read-only health probe, the only
 * two existing Twilio call sites in this codebase before this file).
 *
 * Reuses the SAME env vars those two already read — TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_FROM — rather than inventing new names. An
 * installation with an approved A2P Campaign normally sends through a
 * Messaging Service rather than a bare From number; TWILIO_MESSAGING_SERVICE_SID
 * is read when present and takes priority over TWILIO_FROM (Twilio requires
 * exactly one of MessagingServiceSid / From on a Message create call).
 *
 * Never sends unconditionally: every call here is invoked by lib/smsService.js,
 * which is the ONE place that decides whether a message is allowed to go out
 * (consent, opt-out, quiet hours) — this file has no opinion on any of that,
 * it only talks to Twilio.
 */
'use strict';

const crypto = require('crypto');

const API_BASE = 'https://api.twilio.com/2010-04-01';

function getCredentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  const from = process.env.TWILIO_FROM || null;
  return { accountSid, authToken, messagingServiceSid, from };
}

/** Which required config is missing, without ever returning a secret value. */
function missingConfig() {
  const { accountSid, authToken, messagingServiceSid, from } = getCredentials();
  const missing = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!messagingServiceSid && !from) missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM');
  return missing;
}

/**
 * Send one SMS via Twilio's Message resource.
 * Returns { sid, status, errorCode, errorMessage } — never throws on a
 * Twilio-level rejection (4xx with an error body); throws only on a genuine
 * transport failure (network error, non-JSON response) so the caller can
 * distinguish "Twilio said no" (do not retry, e.g. invalid number) from
 * "we couldn't reach Twilio" (safe to retry).
 */
async function sendMessage({ to, body, statusCallbackUrl }) {
  const missing = missingConfig();
  if (missing.length) {
    const e = new Error(`Twilio not configured — missing: ${missing.join(', ')}`);
    e.code = 'twilio_not_configured';
    throw e;
  }
  const { accountSid, authToken, messagingServiceSid, from } = getCredentials();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const params = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', from);
  if (statusCallbackUrl) params.set('StatusCallback', statusCallbackUrl);

  const res = await fetch(`${API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      sid: null,
      status: 'failed',
      errorCode: data && data.code != null ? String(data.code) : String(res.status),
      errorMessage: (data && data.message) || `Twilio Message create failed HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    sid: data.sid,
    status: data.status || 'queued',
    errorCode: data.error_code != null ? String(data.error_code) : null,
    errorMessage: data.error_message || null,
  };
}

/**
 * Verify Twilio's X-Twilio-Signature header per Twilio's documented algorithm:
 * base64(HMAC-SHA1(AuthToken, fullUrl + sorted-concatenated "key"+"value" pairs
 * of every POST param)). Twilio signs the exact URL it POSTed to, including
 * query string — callers must pass that exact URL (see routes/sms.js, which
 * derives it from req using the same TWILIO_WEBHOOK_BASE_URL/CRM_PUBLIC_URL
 * convention already used elsewhere for externally-visible URLs, never
 * req.protocol/req.get('host') alone, which a proxy can rewrite).
 *
 * Returns true (skip verification) when TWILIO_AUTH_TOKEN is unset — matches
 * this codebase's existing "not configured → skip verification" convention
 * (see routes/metaWebhook.js#verifyMetaSignature) so a not-yet-configured
 * installation's webhook doesn't hard-fail before it's ever wired up.
 */
function verifyTwilioSignature(url, params, signatureHeader) {
  const { authToken } = getCredentials();
  if (!authToken) return true;
  if (!signatureHeader) return false;
  const sortedKeys = Object.keys(params || {}).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

module.exports = { sendMessage, verifyTwilioSignature, missingConfig, getCredentials };
