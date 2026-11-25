/* eslint-disable no-undef */
'use strict';

/**
 * qbCustomerCache — a durable, TTL-based cache of QuickBooks Customer
 * display name / email / phone, keyed by qb_customer_id.
 *
 * Built for the November 2026 "QuickBooks API quota management" CRM
 * reliability request's audit: server.js's QB Estimate Sync cron (every
 * 15 minutes, unconditional) and lib/qbSyncTrigger.js's webhook-triggered
 * sync BOTH re-fetched a full Customer record from Intuit for every
 * estimate on every single run — the former with an in-process cache that
 * is recreated fresh on every tick (so it never actually avoided a repeat
 * fetch across ticks), the latter with no caching at all, not even within
 * one run. Against the ~100 customers this installation has mapped, this
 * alone projects to roughly 290,000 calls/month at the estimate-sync
 * cron's 15-minute cadence — a second major, independent contributor to
 * the same monthly CorePlus quota exhaustion incident the inbound-
 * reconciliation cron's interval widening (PR #81) already addressed.
 *
 * This cache is PURE ENRICHMENT data — a customer's display name/email/
 * phone, used only for CRM lead-matching display fields. It is NEVER used
 * for the actual financial data being synced (invoices, payments,
 * estimates) — those are always fetched fresh on every run, completely
 * unaffected by this cache. A customer's contact details changing between
 * cache refreshes (rare) only means a lead-matching attempt uses a
 * slightly stale email/phone for up to the TTL window — never a
 * financial-accuracy risk.
 *
 * Default TTL: 24 hours (QB_CUSTOMER_CACHE_TTL_MS, configurable). A cache
 * miss or expired entry falls through to a real QuickBooks API call via
 * the caller-supplied `fetchFn` (the caller's own, already-canonical
 * qbApiRequest-based fetch — this module never makes its own QB call) and
 * the fresh result is written back to the cache.
 */

const db = require('../db/client');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function getTtlMs() {
  const raw = process.env.QB_CUSTOMER_CACHE_TTL_MS;
  const n = raw != null && raw !== '' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

let deps = { query: (...args) => db.query(...args) };
function _setDeps(overrides) { deps = { ...deps, ...overrides }; }
function _resetDeps() { deps = { query: (...args) => db.query(...args) }; }

/**
 * Returns a cached customer record (shaped exactly like a raw QB
 * `Customer` object: { DisplayName, PrimaryEmailAddr, PrimaryPhone, ... })
 * if a fresh (within TTL) row exists, else calls `fetchFn()` (expected to
 * return the raw QB Customer object or null/undefined on a genuine
 * not-found), caches a non-null result, and returns it. A cache write
 * failure never blocks returning the real result to the caller — this
 * module degrades to "always call fetchFn" on any of its own errors,
 * never the other way around (never hides a real customer behind a stale
 * or broken cache read).
 */
async function getOrFetchCustomer(qbCustomerId, fetchFn) {
  const id = String(qbCustomerId);
  try {
    const cached = await deps.query(
      `SELECT raw_customer, fetched_at FROM qb_customer_metadata_cache WHERE qb_customer_id = $1`,
      [id]
    );
    const row = cached.rows[0];
    if (row && row.raw_customer) {
      const ageMs = Date.now() - new Date(row.fetched_at).getTime();
      if (ageMs < getTtlMs()) return row.raw_customer;
    }
  } catch (e) {
    console.warn(`[qb-customer-cache] read failed for ${id} (falling through to a real fetch): ` + e.message);
  }

  const fresh = await fetchFn();
  if (fresh) {
    try {
      await deps.query(
        `INSERT INTO qb_customer_metadata_cache (qb_customer_id, display_name, email, phone, raw_customer, fetched_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (qb_customer_id) DO UPDATE
           SET display_name = $2, email = $3, phone = $4, raw_customer = $5, fetched_at = now()`,
        [
          id,
          fresh.DisplayName || null,
          fresh.PrimaryEmailAddr?.Address || null,
          fresh.PrimaryPhone?.FreeFormNumber || null,
          JSON.stringify(fresh),
        ]
      );
    } catch (e) {
      console.warn(`[qb-customer-cache] write failed for ${id} (non-fatal — the fresh result is still returned): ` + e.message);
    }
  }
  return fresh;
}

/** Read-only diagnostic for System Health / admin reporting. */
async function getCacheStats() {
  try {
    const result = await deps.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE fetched_at > now() - interval '24 hours') AS fresh_24h
       FROM qb_customer_metadata_cache`
    );
    const row = result.rows[0] || {};
    return { available: true, total_cached: Number(row.total) || 0, fresh_within_24h: Number(row.fresh_24h) || 0, ttl_ms: getTtlMs() };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

module.exports = { getOrFetchCustomer, getCacheStats, getTtlMs, DEFAULT_TTL_MS, _setDeps, _resetDeps };
