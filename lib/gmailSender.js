/* eslint-disable no-undef */
/**
 * Gmail OAuth + send — Railway-owned, independent of the Base44 gmail
 * connector. Refreshes the access token on each run using a long-lived
 * refresh token for the sending account (yaron@ecconstructiongroup.com),
 * then sends RFC822 messages via the Gmail REST API (same path the Base44
 * connector used: gmail.googleapis.com/.../users/me/messages/send).
 *
 * Env:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   GMAIL_FROM_NAME (default "EC Construction Group")
 *   GMAIL_FROM_ADDRESS (default "yaron@ecconstructiongroup.com")
 *
 * Error model:
 *   GmailCredentialsError — refresh token invalid/revoked, or send-time 401.
 *     This is credential-fatal: blocks ALL sending until the lock is cleared.
 *   plain Error — transient send/transport failure. Retryable.
 */
'use strict';

const gmailCredStore = require('./gmailCredentialStore');

const ENVIRONMENT = process.env.QB_ENVIRONMENT || process.env.NODE_ENV || 'production';

class GmailCredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GmailCredentialsError';
    this.errorType = 'gmail_credentials';
  }
}

// RFC 2047 encoded-word so emoji subjects survive transport.
function encodeSubject(subject) {
  const encoded = Buffer.from(subject, 'utf8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

// Resolve Gmail OAuth creds: prefer the encrypted integration_credentials
// store (Phase B/C migration); fall back to env vars so current production
// behavior is unchanged until the Gmail OAuth credential is stored.
async function resolveGmailCreds() {
  try {
    const cred = await gmailCredStore.loadGmailCredential(ENVIRONMENT);
    if (cred && cred.refresh_token && cred.client_id && cred.client_secret) {
      return {
        clientId: cred.client_id,
        clientSecret: cred.client_secret,
        refreshToken: cred.refresh_token,
        accountIdentifier: cred.account_identifier,
        fromStore: true,
      };
    }
  } catch (e) {
    // Store unavailable / not configured — fall through to env. Never fatal.
    console.warn('[gmailSender] credential store load failed, using env:', e.message);
  }
  return {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    accountIdentifier: process.env.GMAIL_FROM_ADDRESS || gmailCredStore.DEFAULT_ACCOUNT,
    fromStore: false,
  };
}

async function refreshAccessToken() {
  const creds = await resolveGmailCreds();
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    throw new GmailCredentialsError('Gmail OAuth not configured (store or GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN)');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errCode = data.error || '';
    const isCred = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'token_revoked'].includes(errCode);
    if (creds.fromStore) {
      try { await gmailCredStore.markError(ENVIRONMENT, creds.accountIdentifier, `Gmail refresh failed: ${data.error_description || errCode}`); } catch (_) {}
    }
    if (isCred) throw new GmailCredentialsError(`Gmail refresh failed: ${data.error_description || errCode}`);
    throw new Error(`Gmail refresh ${res.status}: ${data.error_description || errCode || 'unknown'}`);
  }
  // Persist rotated refresh token + record usage (best-effort, store-only).
  if (creds.fromStore) {
    try {
      const rotatedRefresh = data.refresh_token && data.refresh_token !== creds.refreshToken ? data.refresh_token : creds.refreshToken;
      await gmailCredStore.saveGmailCredential(ENVIRONMENT, {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: rotatedRefresh,
        access_token: data.access_token,
        access_token_expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
        account_identifier: creds.accountIdentifier,
      });
      await gmailCredStore.markUsed(ENVIRONMENT, creds.accountIdentifier);
    } catch (e) {
      console.warn('[gmailSender] credential store persist/markUsed failed (non-fatal):', e.message);
    }
  }
  return data.access_token;
}

// Pure RFC 2822/MIME builder (no network). Exported so it can be validated
// without sending. Supports CC, Reply-To, custom headers, and attachments
// (multipart/mixed). Non-ASCII filenames use RFC 2231 (filename*=UTF-8'').
function buildMime({ to, cc, subject, htmlBody, replyTo, fromName, fromAddress, headers, attachments }) {
  const fName = fromName || process.env.GMAIL_FROM_NAME || 'EC Construction Group';
  const fAddr = fromAddress || process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
  const from = `${fName} <${fAddr}>`;
  const ccAddrs = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headerLines = [`From: ${from}`, `To: ${to}`];
  if (ccAddrs.length > 0) headerLines.push(`Cc: ${ccAddrs.join(', ')}`);
  headerLines.push(`Subject: ${encodeSubject(subject)}`);
  if (replyTo) headerLines.push(`Reply-To: ${replyTo}`);
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v != null && v !== '') headerLines.push(`${k}: ${v}`);
    }
  }
  headerLines.push(`MIME-Version: 1.0`);

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const rootBoundary = hasAttachments ? `mixed_${boundary}` : boundary;
  headerLines.push(hasAttachments
    ? `Content-Type: multipart/mixed; boundary="${rootBoundary}"`
    : `Content-Type: multipart/alternative; boundary="${boundary}"`);

  const parts = [];
  if (hasAttachments) {
    parts.push(`--${rootBoundary}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, ``);
  }
  parts.push(`--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, ``, `This is an HTML email from EC Construction Group. Please view it in an HTML-capable email client.`, ``);
  parts.push(`--${boundary}`, `Content-Type: text/html; charset="UTF-8"`, ``, htmlBody, ``, `--${boundary}--`);

  if (hasAttachments) {
    for (const a of attachments) {
      const rawName = String((a && a.filename) || 'attachment');
      const asciiName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ct = (a && a.contentType) || 'application/octet-stream';
      const b64 = String((a && a.contentBase64) || '').replace(/\s/g, '');
      let disp;
      if (/[^\x00-\x7f]/.test(rawName)) {
        // RFC 2231 for non-ASCII filenames: ASCII fallback + UTF-8 encoded continuation.
        disp = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`;
      } else {
        disp = `attachment; filename="${asciiName}"`;
      }
      parts.push(`--${rootBoundary}`, `Content-Type: ${ct}; name="${asciiName}"`, `Content-Disposition: ${disp}`, `Content-Transfer-Encoding: base64`, ``, b64.match(/.{1,76}/g).join('\r\n'), ``);
    }
    parts.push(`--${rootBoundary}--`);
  }

  return [...headerLines, ``, ...parts].join('\r\n');
}

async function sendEmail(accessToken, {
  to, cc, subject, htmlBody, replyTo, fromName, fromAddress, headers, attachments, ics,
}) {
  const rawMessage = buildMime({ to, cc, subject, htmlBody, replyTo, fromName, fromAddress, headers, attachments });

  const encoded = Buffer.from(rawMessage, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    if (res.status === 401 || data.error?.errors?.[0]?.reason === 'invalidGrant') {
      throw new GmailCredentialsError(`Gmail send auth failed: ${msg}`);
    }
    throw new Error(`Gmail send ${res.status}: ${msg}`);
  }
  return { id: data.id };
}

module.exports = { refreshAccessToken, sendEmail, buildMime, GmailCredentialsError, encodeSubject };