'use strict';
/**
 * Base44 Entity Gateway client (Railway → Base44 railwayEntityGateway).
 *
 * Env:
 *   BASE44_ENTITY_GATEWAY_URL  — the railwayEntityGateway function URL
 *   WORKER_SECRET              — shared secret, sent via x-railway-secret header
 *
 * Retry policy:
 *   - Write actions (upsert_handoff_estimates, update_estimate_pdf): NEVER retried.
 *     A network error or 504 is INDETERMINATE — the write may still complete after
 *     the HTTP response times out. A read/check is required before any retry.
 *   - Read actions: one limited retry for transient network errors or 502/503.
 *   - Never retries: 400, 401, 403, 404, 405, 413, 429.
 *   - 429: preserves Retry-After but does NOT sleep or retry in this phase.
 *
 * Safe logging: logs only action, requestId, status, durationMs, result.
 */
const BASE44_ENTITY_GATEWAY_URL = process.env.BASE44_ENTITY_GATEWAY_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

const CLIENT_TIMEOUT_MS = 12000; // shorter than the gateway's 15s timeout

const READ_ACTIONS = new Set(['get_lead', 'find_handoff_estimates_by_qb_ids', 'get_handoff_estimate']);
const WRITE_ACTIONS = new Set(['upsert_handoff_estimates', 'update_estimate_pdf']);

function isConfigured() {
  return !!(BASE44_ENTITY_GATEWAY_URL && WORKER_SECRET);
}

function missingConfig() {
  const missing = [];
  if (!BASE44_ENTITY_GATEWAY_URL) missing.push('BASE44_ENTITY_GATEWAY_URL');
  if (!WORKER_SECRET) missing.push('WORKER_SECRET');
  return missing;
}

function safeLog(action, requestId, status, durationMs, result) {
  console.log(JSON.stringify({ component: 'base44EntityGateway', action, requestId, status, durationMs, result }));
}

/** Low-level fetch. Returns { parsed, status, retryAfter }. Throws on network/timeout. */
async function rawCall(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(BASE44_ENTITY_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-railway-secret': WORKER_SECRET },
      body,
      signal: controller.signal,
    });
    const retryAfter = res.headers.get('Retry-After');
    let parsed;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { parsed, status: res.status, retryAfter };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the gateway. Returns a structured result:
 *   { success, data?, warnings?, error?, requestId, status, indeterminate, retryAfter? }
 */
async function callGateway(action, payload) {
  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
    return { success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: ' + action }, requestId: null, status: null, indeterminate: false };
  }
  if (!isConfigured()) {
    safeLog(action, null, null, 0, 'config_error');
    return { success: false, error: { code: 'CONFIG_ERROR', message: 'Base44 gateway not configured: missing ' + missingConfig().join(', ') }, requestId: null, status: null, indeterminate: false };
  }

  const body = JSON.stringify(Object.assign({ action }, payload || {}));
  const isWrite = WRITE_ACTIONS.has(action);
  const start = Date.now();

  const doAttempt = async () => {
    try {
      const { parsed, status, retryAfter } = await rawCall(body);
      const requestId = (parsed && parsed.requestId) || null;
      const durationMs = Date.now() - start;
      safeLog(action, requestId, status, durationMs, status >= 200 && status < 300 ? 'success' : 'error');

      if (parsed && parsed.success) {
        return { success: true, data: parsed.data || {}, warnings: parsed.warnings || [], requestId, status, indeterminate: false, __retryable: false };
      }
      const result = {
        success: false,
        error: { code: (parsed && parsed.error && parsed.error.code) || 'GATEWAY_ERROR', message: (parsed && parsed.error && parsed.error.message) || ('Gateway returned ' + status) },
        requestId, status, indeterminate: false,
        __retryable: status === 502 || status === 503,
      };
      if (status === 429) result.retryAfter = retryAfter || null;
      return result;
    } catch (e) {
      const durationMs = Date.now() - start;
      const isTimeout = e.name === 'AbortError';
      safeLog(action, null, null, durationMs, isTimeout ? 'timeout' : 'network_error');
      return {
        success: false,
        error: { code: isTimeout ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR', message: isTimeout ? 'Request timed out' : 'Network error' },
        requestId: null, status: null,
        indeterminate: isWrite,
        __retryable: !isWrite, // reads can retry on network error; writes cannot
      };
    }
  };

  const first = await doAttempt();
  if (!first.__retryable || isWrite) {
    delete first.__retryable;
    return first;
  }
  // Read action + retryable (502/503/network): one retry only
  safeLog(action, first.requestId, first.status, 0, 'retrying_read');
  const second = await doAttempt();
  delete second.__retryable;
  return second;
}

module.exports = { callGateway, isConfigured, READ_ACTIONS, WRITE_ACTIONS };