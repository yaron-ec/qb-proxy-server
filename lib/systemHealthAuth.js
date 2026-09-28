/* eslint-disable no-undef */
/**
 * systemHealthAuth — authentication for the read-only admin System Health
 * endpoints (routes/systemHealth.js). Two identities are accepted:
 *
 *   1. A CRM admin: the normal Railway JWT (lib/rbac requireAuth + role admin).
 *   2. The production verification workflow, by GitHub Actions OIDC — a
 *      short-lived RS256 token GitHub signs for ONE workflow run. No stored
 *      secret exists to leak. Accepted only when ALL hold:
 *        iss  = https://token.actions.githubusercontent.com (signature checked
 *               against GitHub's published JWKS)
 *        aud  = ec-crm-system-health
 *        repository = SYSTEM_HEALTH_CI_REPOSITORY (a PRIVATE repo, so run logs
 *               are not public) and repository_visibility = private
 *        workflow_ref = <repo>/.github/workflows/final-verify.yml@…
 *        not expired / not before.
 *      It grants the synthetic role 'system_health' and is honoured ONLY by the
 *      System Health router — never by any other route.
 */
'use strict';

const crypto = require('crypto');
const { verifyAccessToken } = require('./authService');

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_AUDIENCE = 'ec-crm-system-health';
const CI_REPOSITORY = process.env.SYSTEM_HEALTH_CI_REPOSITORY || 'yaron-ec/ec-construction-group-website';
const CI_WORKFLOW = '.github/workflows/final-verify.yml';

let jwksCache = null; // { at, keys }
async function githubJwks(fetchImpl, force) {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3600 * 1000) return jwksCache.keys;
  const r = await fetchImpl(`${OIDC_ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwksCache.keys;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Verify a GitHub Actions OIDC token; returns its claims or throws. */
async function verifyGithubOidc(token, { fetchImpl = fetch, now = Date.now(), jwks } = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('alg');
  let keys = jwks || await githubJwks(fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk && !jwks) { keys = await githubJwks(fetchImpl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('unknown kid');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('signature');
  const t = Math.floor(now / 1000);
  if (claims.iss !== OIDC_ISSUER) throw new Error('iss');
  if (claims.aud !== OIDC_AUDIENCE) throw new Error('aud');
  if (!(claims.exp > t) || (claims.nbf && claims.nbf > t + 60)) throw new Error('expired');
  if (claims.repository !== CI_REPOSITORY) throw new Error('repository');
  if (claims.repository_visibility !== 'private') throw new Error('visibility');
  if (!String(claims.workflow_ref || '').startsWith(`${CI_REPOSITORY}/${CI_WORKFLOW}@`)) throw new Error('workflow');
  return claims;
}

/** Express middleware: CRM admin JWT, or the verification workflow's OIDC token. */
function requireAdminOrVerificationWorkflow(opts = {}) {
  return async function (req, res, next) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    if (!m) return res.status(401).json({ error: 'missing bearer token' });
    const token = m[1].trim();
    let iss = null;
    try { iss = b64json(token.split('.')[1] || '').iss; } catch (_) { /* not a JWT we can read */ }
    if (iss === OIDC_ISSUER) {
      try {
        const c = await verifyGithubOidc(token, opts);
        req.user = { sub: `github-oidc:${c.repository}:${c.run_id}`, role: 'system_health' };
        return next();
      } catch (e) {
        return res.status(401).json({ error: 'invalid workflow identity' });
      }
    }
    try {
      req.user = verifyAccessToken(token);
    } catch (e) {
      return res.status(401).json({ error: 'invalid token' });
    }
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden: admin only' });
    next();
  };
}

module.exports = { requireAdminOrVerificationWorkflow, verifyGithubOidc, OIDC_AUDIENCE, OIDC_ISSUER, CI_REPOSITORY, CI_WORKFLOW };
