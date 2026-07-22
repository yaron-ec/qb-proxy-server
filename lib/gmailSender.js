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

async function refreshAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailCredentialsError('Gmail OAuth not configured (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN)');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errCode = data.error || '';
    if (['invalid_grant', 'invalid_client', 'unauthorized_client', 'token_revoked'].includes(errCode)) {
      throw new GmailCredentialsError(`Gmail refresh failed: ${data.error_description || errCode}`);
    }
    throw new Error(`Gmail refresh ${res.status}: ${data.error_description || errCode || 'unknown'}`);
  }
  return data.access_token;
}

async function sendEmail(accessToken, { to, subject, htmlBody }) {
  const fromName = process.env.GMAIL_FROM_NAME || 'EC Construction Group';
  const fromAddr = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
  const from = `${fromName} <${fromAddr}>`;
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const rawMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    `This is an HTML email from EC Construction Group. Please view it in an HTML-capable email client.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ].join('\r\n');

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

module.exports = { refreshAccessToken, sendEmail, GmailCredentialsError, encodeSubject };