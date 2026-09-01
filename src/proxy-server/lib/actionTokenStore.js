/* eslint-disable no-undef */
/**
 * Opaque, DB-backed action tokens for reminder email buttons.
 *
 * Security model (requirement: truly opaque tokens):
 *   - Generate 32 cryptographically-random bytes; the base64url of those bytes
 *     is the raw token placed in the customer URL.
 *   - Store ONLY SHA-256(rawToken) in PostgreSQL. The raw token is never stored,
 *     never logged, and never compared in clear text.
 *   - Lookup re-hashes the incoming token and compares the hash (index lookup).
 *
 * Each token row binds a single action (confirm|reschedule|contact) to a
 * specific appointment instance via `appointment_fingerprint`, carries an
 * `expires_at`, and stores a display `snapshot` (rep + appointment + client)
 * so the action page never reads representative/appointment data from Base44.
 */
'use strict';

const crypto = require('crypto');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Stable appointment fingerprint = SHA-256 of a normalized concatenation of
 * lead_id + appointment date + time + type + assigned rep email. Any change to
 * date/time/type/rep produces a different fingerprint, which makes old links
 * fail change-detection and show the "appointment changed" page.
 */
function fingerprint({ leadId, date, time, type, repEmail }) {
  const norm = [leadId || '', date || '', time || '', type || '', (repEmail || '').toLowerCase()]
    .join('|');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

/**
 * Issue a token: insert a row keyed by SHA-256(rawToken). Returns the raw token
 * (caller puts it in the email URL) and the stored hash. Retries on the rare
 * hash-collision unique violation.
 */
async function issueToken(db, { leadId, appointmentFingerprint, actionType, snapshot, ttlDays }) {
  const ttlMs = (ttlDays != null ? ttlDays : 30) * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  for (let i = 0; i < 5; i++) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(raw);
    try {
      await db.query(
        `INSERT INTO reminder_action_tokens
           (token_hash, lead_id, appointment_fingerprint, action_type, expires_at, status, snapshot)
         VALUES ($1,$2,$3,$4,$5,'active',$6)`,
        [tokenHash, leadId, appointmentFingerprint, actionType, expiresAt, JSON.stringify(snapshot || {})]
      );
      return { raw, tokenHash, expiresAt };
    } catch (e) {
      if (e && e.code === '23505') continue; // unique collision — regenerate
      throw e;
    }
  }
  throw new Error('action token: could not issue (repeated unique collision)');
}

/**
 * Validate + resolve an incoming raw token. Returns the token row or null.
 * Never logs the raw token. Caller checks expires_at separately so it can
 * render the branded "expired" page rather than a generic invalid one.
 */
async function lookupToken(db, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await db.query(
    `SELECT * FROM reminder_action_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] || null;
}

module.exports = { fingerprint, hashToken, issueToken, lookupToken };