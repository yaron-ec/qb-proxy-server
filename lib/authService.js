/* eslint-disable no-undef */
/**
 * Railway authentication service — PERMANENT identity layer.
 *
 * Issues/verifies Railway JWT access tokens and rotating refresh tokens,
 * and authenticates users by password (scrypt). Google OIDC SSO is the
 * intended primary login path (google_sub column); password login is a
 * fallback. Base44 is NOT involved here.
 *
 * Tables: users, refresh_tokens (db/schema.sql, Phase 1 migration).
 * Env: RAILWAY_JWT_SECRET (server-side only).
 */
'use strict';

const db = require('../db/client');
const { signJWT, verifyJWT, hashPassword, verifyPassword, randomToken, sha256Hex } = require('./crypto');

const ACCESS_TTL_SECONDS = 15 * 60;        // 15 min
const REFRESH_TTL_DAYS = 30;
const REFRESH_TTL_SECONDS = REFRESH_TTL_DAYS * 24 * 60 * 60;

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, full_name: u.full_name, role: u.role, status: u.status };
}

function issueAccessToken(user) {
  return signJWT({
    sub: user.id,
    email: user.email,
    role: user.role,
    full_name: user.full_name || '',
  }, ACCESS_TTL_SECONDS);
}

async function issueRefreshToken(user) {
  const raw = randomToken(32);
  const tokenHash = sha256Hex(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [tokenHash, user.id, expiresAt]
  );
  return raw;
}

async function issueSession(user) {
  const access = issueAccessToken(user);
  const refresh = await issueRefreshToken(user);
  return { access, refresh, user: publicUser(user), accessTtlSeconds: ACCESS_TTL_SECONDS };
}

async function getUserById(id) {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await db.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] || null;
}

async function authenticatePassword(email, password) {
  const user = await getUserByEmail(email);
  if (!user || user.status !== 'active' || !user.password_hash) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

async function findOrCreateByGoogleSub(googleSub, email, fullName) {
  // SSO path: match by google_sub, else by email, else create.
  const { rows } = await db.query(
    `SELECT * FROM users WHERE google_sub = $1 OR lower(email) = lower($2) LIMIT 1`,
    [googleSub, email]
  );
  if (rows[0]) {
    if (!rows[0].google_sub) {
      await db.query(`UPDATE users SET google_sub = $1, updated_at = NOW() WHERE id = $2`, [googleSub, rows[0].id]);
    }
    return rows[0];
  }
  const ins = await db.query(
    `INSERT INTO users (email, full_name, role, google_sub) VALUES ($1, $2, 'user', $3) RETURNING *`,
    [email, fullName || null, googleSub]
  );
  return ins.rows[0];
}

// Rotate a refresh token: revoke the old, issue a new one (single-use rotation).
async function rotateRefreshToken(rawRefresh) {
  const tokenHash = sha256Hex(rawRefresh);
  const claim = await db.query(
    `UPDATE refresh_tokens
       SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [tokenHash]
  );
  if (!claim.rows.length) throw new Error('invalid or expired refresh token');
  const user = await getUserById(claim.rows[0].user_id);
  if (!user) throw new Error('user not found');
  const access = issueAccessToken(user);
  const newRaw = randomToken(32);
  const newHash = sha256Hex(newRaw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at, rotated_from) VALUES ($1, $2, $3, $4)`,
    [newHash, user.id, expiresAt, tokenHash]
  );
  return { access, refresh: newRaw, user: publicUser(user), accessTtlSeconds: ACCESS_TTL_SECONDS };
}

async function revokeRefreshToken(rawRefresh) {
  const tokenHash = sha256Hex(rawRefresh);
  await db.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
}

function verifyAccessToken(token) {
  return verifyJWT(token); // throws on invalid/expired
}

// Admin bootstrap / user provisioning (admin-only via API; not auto-called).
async function createUser({ email, full_name, role, password }) {
  const hash = password ? hashPassword(password) : null;
  const { rows } = await db.query(
    `INSERT INTO users (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, full_name || null, role || 'user', hash]
  );
  return rows[0];
}

async function setEmailPassword(userId, password) {
  const hash = hashPassword(password);
  await db.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, userId]);
}

module.exports = {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  issueSession,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  verifyAccessToken,
  authenticatePassword,
  getUserById,
  getUserByEmail,
  findOrCreateByGoogleSub,
  createUser,
  setEmailPassword,
  publicUser,
};