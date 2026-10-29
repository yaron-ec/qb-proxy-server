/* eslint-disable no-undef */
'use strict';

/**
 * qbRateLimitBreaker — a shared, cross-process circuit breaker for
 * QuickBooks DATA calls (never the OAuth token-refresh endpoint — see
 * lib/qbTokenManager.js#qbApiRequest, the ONE place this is wired in).
 *
 * October 2026 production incident, round 2: PR #47 added a bounded
 * per-call 429/5xx retry (lib/qbTokenManager.js) and per-customer pacing
 * (lib/qbInboundSync.js), but neither stops a SUSTAINED rate limit from
 * being hammered continuously. The 100+ customer reconciliation loop (and
 * the previously-unpaced Estimate Sync customer-fetch / PDF-fetch loops in
 * server.js, also fixed in this same pass) kept retrying every single
 * call: each one waited out its own Retry-After and then moved straight to
 * the next customer, which 429'd again — "retry 1/2 (1000ms)" / "retry 2/2
 * (1000ms)" repeating almost every second in the logs for the full
 * multi-minute duration of a tick, which can itself help keep Intuit's
 * rate-limit window from ever clearing.
 *
 * This adds a classic closed / open / half-open breaker:
 *   - CLOSED (normal): every call proceeds exactly as before.
 *   - OPEN: a run of consecutive TERMINAL 429/5xx failures (i.e. failures
 *     AFTER qbApiRequest's own per-call retry budget is already exhausted
 *     — an isolated, successfully-retried blip never counts) trips the
 *     breaker. While open, qbApiRequest skips the network call entirely,
 *     for every QuickBooks data caller (inbound reconciliation, estimate
 *     sync, PDF sync, the legacy proxy routes, qbSyncTrigger) — the one
 *     shared path they all already go through.
 *   - HALF_OPEN: once the cooldown elapses, exactly ONE trial call is let
 *     through (the first caller to win a conditional UPDATE). Success
 *     closes the breaker and resets all bookkeeping; a failed trial
 *     reopens it with a longer, capped, jittered cooldown. If the trial
 *     caller never reports back at all (a crash/hang) the half-open state
 *     self-expires after HALF_OPEN_TIMEOUT_MS so the breaker can never get
 *     stuck open forever.
 *
 * State lives in the pre-existing `app_settings` key-value table (one row,
 * key='qb_rate_limit_breaker') rather than a new table or in-process
 * memory — this is what makes it correct across multiple Railway
 * replicas/processes, not merely within one Node process, per this
 * incident's explicit requirement. Every write is a single, atomic
 * single-row UPDATE (Postgres serializes concurrent writers on that row),
 * so no additional locking is needed for correctness; at worst, two
 * near-simultaneous "open" transitions both succeed with slightly
 * different cooldowns, which is safe, not a race that can corrupt state.
 *
 * Fails OPEN on its own error: a transient DB hiccup while reading or
 * writing breaker state must never block a real QuickBooks call — see the
 * try/catch wrapping every call into this module from qbTokenManager.js.
 */

const db = require('../db/client');

const KEY = 'qb_rate_limit_breaker';
const FAILURE_THRESHOLD = 5; // consecutive TERMINAL (retry-exhausted) failures before opening
const BASE_COOLDOWN_MS = 60 * 1000; // 1 minute
const MAX_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes — hard cap, cooldown never grows unbounded
const JITTER_MS = 5 * 1000;
const HALF_OPEN_TIMEOUT_MS = 30 * 1000; // self-recovery if the trial caller never reports back

function defaultState() {
  return {
    state: 'closed',
    consecutive_failures: 0,
    opens_count: 0,
    cooldown_until: null,
    half_open_since: null,
    opened_at: null,
    last_status: null,
    last_transition_at: null,
  };
}

async function ensureRow() {
  await db.query(
    `INSERT INTO app_settings (key, value, type) VALUES ($1, $2::jsonb, 'json') ON CONFLICT (key) DO NOTHING`,
    [KEY, JSON.stringify(defaultState())]
  );
}

async function getState() {
  await ensureRow();
  const r = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [KEY]);
  return r.rows[0] ? r.rows[0].value : defaultState();
}

async function writeState(value) {
  await db.query(
    `UPDATE app_settings SET value = $2::jsonb, updated_at = NOW() WHERE key = $1`,
    [KEY, JSON.stringify(value)]
  );
}

function computeCooldownMs(opensCount) {
  const base = BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, opensCount - 1));
  return Math.min(base, MAX_COOLDOWN_MS) + Math.floor(Math.random() * JITTER_MS);
}

/**
 * Called before every QuickBooks DATA call. Returns:
 *   { allow: true, state }                      — closed, proceed normally.
 *   { allow: true, trial: true, state }          — open cooldown elapsed;
 *     THIS caller won the one trial slot — it must report back via
 *     recordSuccess()/recordFailure().
 *   { allow: false, reason, retryAt, state }     — denied (still cooling
 *     down, or another caller already holds the trial slot).
 */
async function checkAndMaybeAllow() {
  const state = await getState();

  if (state.state === 'closed') return { allow: true, state };

  if (state.state === 'half_open') {
    const since = state.half_open_since ? new Date(state.half_open_since).getTime() : 0;
    if (Date.now() - since > HALF_OPEN_TIMEOUT_MS) {
      // The previous trial caller never reported back (crash/hang) — force
      // the cooldown to "already elapsed" so the re-check just below grants
      // a fresh trial instead of leaving every future call deadlocked.
      await db.query(
        `UPDATE app_settings
         SET value = jsonb_set(jsonb_set(value, '{state}', '"open"'::jsonb), '{cooldown_until}', to_jsonb(NOW()::text)),
             updated_at = NOW()
         WHERE key = $1 AND value->>'state' = 'half_open' AND value->>'half_open_since' = $2`,
        [KEY, state.half_open_since]
      );
      return checkAndMaybeAllow();
    }
    return { allow: false, reason: 'half_open_in_progress', retryAt: null, state };
  }

  // state.state === 'open'
  const cooldownUntilMs = state.cooldown_until ? new Date(state.cooldown_until).getTime() : 0;
  if (Date.now() < cooldownUntilMs) {
    return { allow: false, reason: 'cooldown', retryAt: state.cooldown_until, state };
  }

  // Cooldown elapsed — let exactly ONE caller through as the trial. The
  // conditional UPDATE means only the first of any number of concurrent
  // callers (across processes/replicas) actually flips the state; every
  // other concurrent caller sees 0 rows affected and stays denied.
  const r = await db.query(
    `UPDATE app_settings
     SET value = jsonb_set(jsonb_set(value, '{state}', '"half_open"'::jsonb), '{half_open_since}', to_jsonb(NOW()::text)),
         updated_at = NOW()
     WHERE key = $1 AND value->>'state' = 'open'
       AND value->>'cooldown_until' IS NOT NULL
       AND (value->>'cooldown_until')::timestamptz <= NOW()
     RETURNING value`,
    [KEY]
  );
  if (r.rows.length > 0) return { allow: true, trial: true, state: r.rows[0].value };
  return { allow: false, reason: 'cooldown', retryAt: state.cooldown_until, state };
}

/** A QuickBooks data call succeeded (first attempt or after qbApiRequest's
 * own internal retries) — close the breaker and reset all bookkeeping. */
async function recordSuccess() {
  await ensureRow();
  await writeState({ ...defaultState(), last_transition_at: new Date().toISOString() });
}

/** A QuickBooks data call's own retry budget was exhausted and it is STILL
 * a 429/5xx — one terminal failure toward the sustained-failure threshold,
 * or (if this was the one half-open trial) an immediate reopen. */
async function recordFailure(status) {
  await ensureRow();
  const r = await db.query(
    `UPDATE app_settings
     SET value = jsonb_set(value, '{consecutive_failures}', to_jsonb(COALESCE((value->>'consecutive_failures')::int, 0) + 1)),
         updated_at = NOW()
     WHERE key = $1
     RETURNING value`,
    [KEY]
  );
  const state = r.rows[0] ? r.rows[0].value : null;
  if (!state) { await ensureRow(); return; }

  if (state.state === 'half_open') {
    const opensCount = (state.opens_count || 0) + 1;
    const cooldownMs = computeCooldownMs(opensCount);
    await writeState({
      ...state,
      state: 'open',
      opens_count: opensCount,
      cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
      half_open_since: null,
      opened_at: state.opened_at || new Date().toISOString(),
      last_status: status ?? null,
      last_transition_at: new Date().toISOString(),
    });
    console.warn(`[qb-circuit] breaker trial failed — reopening for ${cooldownMs}ms (opens_count=${opensCount})`);
    return;
  }

  if (state.state === 'closed' && state.consecutive_failures >= FAILURE_THRESHOLD) {
    const opensCount = (state.opens_count || 0) + 1;
    const cooldownMs = computeCooldownMs(opensCount);
    await writeState({
      ...state,
      state: 'open',
      opens_count: opensCount,
      cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
      half_open_since: null,
      opened_at: new Date().toISOString(),
      last_status: status ?? null,
      last_transition_at: new Date().toISOString(),
    });
    console.warn(`[qb-circuit] sustained QuickBooks ${status} — breaker OPEN for ${cooldownMs}ms after ${state.consecutive_failures} consecutive failures (opens_count=${opensCount})`);
  }
}

module.exports = {
  KEY, FAILURE_THRESHOLD, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS, HALF_OPEN_TIMEOUT_MS,
  getState, checkAndMaybeAllow, recordSuccess, recordFailure,
  _computeCooldownMs: computeCooldownMs,
};
