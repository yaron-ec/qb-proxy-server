/* eslint-disable no-undef */
/**
 * Railway crypto helpers — JWT (HS256) + password hashing (scrypt) + tokens.
 *
 * Uses ONLY Node's built-in `crypto`. No external npm dependency, so the
 * Railway service stays dependency-light and there is no install/version
 * drift risk. This is the permanent auth crypto layer (no Base44 involvement).
 *
 * Env: RAILWAY_JWT_SECRET — HS256 signing secret (server-side only, NEVER
 * exposed to the browser).
 */
'use strict';

const crypto = require('crypto');

const JWT_SECRET = process.env.RAILWAY_JWT_SECRET;
const MIN_SECRET_LEN = 32;
function secretError() {
  if (!JWT_SECRET) return 'RAILWAY_JWT_SECRET not configured';
  if (JWT_SECRET.length < MIN_SECRET_LEN) return `RAILWAY_JWT_SECRET must be at least ${MIN_SECRET_LEN} characters`;
  return null;
}
if (secretError()) {
  console.error('[crypto] WARNING: ' + secretError() + ' — auth endpoints will reject all tokens until it is configured.');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────────

function signJWT(payload, ttlSeconds) {
  const _e = secretError(); if (_e) throw new Error(_e);
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = base64url(Buffer.from(JSON.stringify(header)));
  const p = base64url(Buffer.from(JSON.stringify(body)));
  const sig = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

function verifyJWT(token) {
  const _e = secretError(); if (_e) throw new Error(_e);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const expected = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  if (!constantTimeEqual(s, expected)) throw new Error('invalid signature');
  let payload;
  try { payload = JSON.parse(base64urlDecode(p).toString('utf8')); }
  catch { throw new Error('malformed payload'); }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) throw new Error('token expired');
  return payload;
}

// ── Password hashing (scrypt) ────────────────────────────────────────────────

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_LEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const hash = Buffer.from(parts[5], 'hex');
  if (!salt.length || !hash.length) return false;
  const calc = crypto.scryptSync(String(password), salt, hash.length, { N, r, p });
  return constantTimeEqual(calc, hash);
}

// ── Tokens / hashes ──────────────────────────────────────────────────────────

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

module.exports = {
  signJWT,
  verifyJWT,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  constantTimeEqual,
};