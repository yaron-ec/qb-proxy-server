/* eslint-disable no-undef */
'use strict';

/**
 * qbProactiveHealthCheck — lightweight, read-only scheduled QuickBooks
 * connection check (QuickBooks reliability audit, October 2026).
 *
 * Gap this closes: detection of a revoked/expired QuickBooks grant was
 * previously purely REACTIVE — either the 15-minute QB sync crons' real API
 * calls happened to fail, or an admin manually clicked "Run Live Checks".
 * There was no standalone scheduled probe. This module adds one, without
 * inventing any new refresh, credential, or notification mechanism:
 *
 *   - It calls the ONE existing `qbTokenManager.verifyConnection()` (a
 *     read-only companyinfo GET through the canonical qbApiRequest path).
 *     If the access token is due for refresh, that refresh happens exactly
 *     as it always does — this never bypasses or duplicates the refresh
 *     logic in lib/qbTokenManager.js.
 *   - If that refresh (or the live call itself) discovers the grant is
 *     genuinely revoked, lib/qbTokenManager.js#interpretRefresh ALREADY
 *     calls `deps.notifyReconnectRequired` with its existing per-day,
 *     per-recipient idempotency key — this module adds NO second alert
 *     path and cannot itself cause alert spam beyond what that path
 *     already prevents.
 *   - `shouldSkipProactiveCheck` avoids redundant Intuit API usage: if a
 *     real QuickBooks API call already succeeded more recently than
 *     `skipIfRecentMs` (default 20 minutes — comfortably longer than the
 *     15-minute sync crons' own interval, so their ordinary traffic already
 *     proves the credential live and this check backs off), the live call
 *     is skipped entirely for this tick.
 *
 * Exported as pure, dependency-injected functions (not closed over
 * server.js's module-level state) so this can be unit-tested with fake
 * tokenStore/qbTokenManager implementations, the same way
 * test/qbTokenManager.test.js tests qbTokenManager.js itself.
 */

function shouldSkipProactiveCheck(tokens, { now = Date.now(), skipIfRecentMs } = {}) {
  if (!tokens) return { skip: true, reason: 'not_connected' };
  const lastUsedAt = tokens.last_used_at ? new Date(tokens.last_used_at).getTime() : 0;
  if (now - lastUsedAt < skipIfRecentMs) return { skip: true, reason: 'recently_verified' };
  return { skip: false, reason: null };
}

/**
 * @param {object} deps
 * @param {string} deps.environment
 * @param {string} deps.apiBase
 * @param {object} deps.tokenStore - lib/qbTokenStore.js (or a test double)
 * @param {object} deps.qbTokenManager - lib/qbTokenManager.js (or a test double)
 * @param {number} [deps.skipIfRecentMs]
 * @param {number} [deps.now]
 * @returns {Promise<{ran: boolean, reason?: string, result?: object}>}
 */
async function runProactiveHealthCheck({
  environment, apiBase, tokenStore, qbTokenManager,
  skipIfRecentMs = 20 * 60 * 1000, now = Date.now(),
}) {
  const tokens = await tokenStore.loadPersistedTokens(environment);
  const decision = shouldSkipProactiveCheck(tokens, { now, skipIfRecentMs });
  if (decision.skip) return { ran: false, reason: decision.reason };
  const result = await qbTokenManager.verifyConnection(environment, apiBase);
  return { ran: true, result };
}

module.exports = { shouldSkipProactiveCheck, runProactiveHealthCheck };
