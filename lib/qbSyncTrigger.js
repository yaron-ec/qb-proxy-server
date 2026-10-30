/* eslint-disable no-undef */
/**
 * qbSyncTrigger — Async QB estimate sync trigger for webhook receivers.
 *
 * Extracted from server.js so the QB webhook receiver can trigger a sync
 * without a circular dependency on server.js.
 *
 * Calls the same fetchAllQbEstimates + qbMatch logic as the server.js
 * runQbEstimateSync, but as a fire-and-forget async operation.
 *
 * Token source: lib/qbInboundSync.js's getValidTokens(), which delegates to
 * lib/qbTokenManager.js — the ONE refresh implementation (shared with
 * server.js), over the Postgres-backed credential store (lib/qbTokenStore.js). This module previously
 * read/wrote its own separate `.qb-tokens.encrypted` FILESYSTEM copy, which
 * silently no-op'd in production (the one-time Base44-exit migration
 * deleted that file) — the webhook-triggered "low-latency" sync never
 * actually ran; only the 15-minute cron and the manual Re-sync button did.
 * Reusing getValidTokens() here does not introduce a fourth refresh
 * implementation — it is the same function qbInboundSync.js's own
 * (already-production) inbound reconciliation calls.
 */
'use strict';

const rda = require('./railwayDataAccess');
const qbMatch = require('./qbMatch');
const qbTokenManager = require('./qbTokenManager');
const { getValidTokens } = require('./qbInboundSync');
const { pool } = require('../db/client');
const { tryWithAdvisoryLock } = require('./advisoryLock');
const qbEnvironment = require('./qbEnvironment');

// Resolved once via lib/qbEnvironment.js — the SAME value server.js and
// lib/qbInboundSync.js use, so this module's credential lookup and API
// hostname can never disagree (October 2026 reliability audit — this module
// previously keyed its credential lookup off a SEPARATE QB_SANDBOX
// variable).
const QB_ENVIRONMENT = qbEnvironment.resolveQbEnvironment().environment;
const QB_API_BASE = qbEnvironment.resolveQbApiBase(QB_ENVIRONMENT);

// Cross-process/replica-safe re-entrancy (namespace 1005 — see
// lib/advisoryLock.js's registry; a distinct key from
// lib/qbInboundSync.js's 'qb-inbound-reconcile' and server.js's
// 'qb-estimate-sync', since this is a third, independently-triggered sync).
// Replaces the plain in-process `_syncing` boolean, which never protected
// against two Railway replicas/processes handling concurrent QB webhooks.
const SYNC_LOCK_KEY = 'qb-webhook-sync';
// Same pacing/early-exit rationale as server.js's runQbEstimateSyncInner and
// runQbEstimatePdfSync, and lib/qbInboundSync.js's syncAllMappedCustomers —
// this loop's per-estimate customer fetch had zero pacing and (unlike those
// three) didn't even detect a breaker-open skip to stop early; found during
// the "confirm no remaining unpaced sync loop" review for the Phase 4
// circuit-breaker PR.
const PACING_MS = 150;

async function runQbEstimateSyncAsync() {
  const lockResult = await tryWithAdvisoryLock(pool, 1005, SYNC_LOCK_KEY, runQbEstimateSyncAsyncInner);
  if (lockResult.skipped) console.log('[qb-sync-trigger] Sync already in progress (this or another process) — skipping');
}

async function runQbEstimateSyncAsyncInner() {
  try {
    if (!rda.isConfigured()) throw new Error('DATABASE_URL not configured');

    const storedTokens = await getValidTokens();
    if (!storedTokens) {
      console.warn('[qb-sync-trigger] No QB tokens — skipping sync');
      return;
    }

    // Canonical authenticated request (auto-refresh, one retry on 401); a
    // failed query throws instead of silently looking like "no estimates".
    async function qbQuery(q) {
      const r = await qbTokenManager.qbApiRequest(QB_ENVIRONMENT,
        (t) => `${QB_API_BASE}/${t.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=65`, {});
      if (!r.res.ok) throw new Error(`QB query failed ${r.res.status}`);
      return r.json;
    }

    // Fetch only recently-updated estimates (last 24 hours for webhook-triggered sync)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const all = [];
    let pos = 1;
    while (true) {
      const qr = await qbQuery(`SELECT * FROM Estimate WHERE MetaData.LastUpdatedTime > '${since}' STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Estimate || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }

    if (all.length === 0) {
      console.log('[qb-sync-trigger] No recently-updated estimates');
      return;
    }

    const [leads, existingEstimates] = await Promise.all([
      rda.list('Lead', '-created_date', 2000, 0),
      rda.list('HandoffEstimate', '-created_date', 1000, 0),
    ]);

    let matched = 0, imported = 0, updated = 0, stoppedEarly = false;

    for (let idx = 0; idx < all.length; idx++) {
      const qbEst = all[idx];
      try {
        const qbId = qbEst.Id;
        const customerId = qbEst.CustomerRef?.value;
        const customerRefName = qbEst.CustomerRef?.name || '(Unknown)';

        // Fetch customer for email/phone. qbApiRequest never throws on a
        // non-ok response (including a circuitOpen skip) — it returns
        // {res, json}, so `.ok`/`.circuitOpen` must be checked explicitly
        // here rather than relying on a catch. A circuitOpen skip is NOT
        // an ordinary best-effort miss — it's rethrown so the outer catch
        // below can stop the whole loop instead of silently treating every
        // remaining estimate as "customer not found".
        let fullCustomer = {};
        try {
          const r = await qbTokenManager.qbApiRequest(QB_ENVIRONMENT,
            (t) => `${QB_API_BASE}/${t.realm_id}/customer/${customerId}?minorversion=65`, {});
          if (r.circuitOpen) throw Object.assign(new Error('circuit_open'), { circuitOpen: true });
          if (r.res.ok) fullCustomer = r.json?.Customer || {};
        } catch (e) { if (e.circuitOpen) throw e; /* otherwise best-effort */ }

        const qbCustomer = { ...fullCustomer, DisplayName: fullCustomer.DisplayName || customerRefName, name: customerRefName };
        const existing = existingEstimates.find(e => e.qb_estimate_id === qbId);
        const matchedLead = qbMatch.findMatchingLead(qbCustomer, leads);

        const sharedBase = {
          qb_estimate_id: qbId,
          qb_estimate_number: qbEst.DocNumber,
          customer_name: customerRefName,
          customer_email: fullCustomer.PrimaryEmailAddr?.Address || '',
          customer_phone: fullCustomer.PrimaryPhone?.FreeFormNumber || '',
          estimate_amount: qbEst.TotalAmt || 0,
          estimate_status: qbEst.TxnStatus || 'Pending',
          estimate_date: qbEst.TxnDate,
          last_synced_at: new Date().toISOString(),
          sync_source: 'QuickBooks',
          qb_app_url: `${qbEnvironment.resolveQbAppUrlBase(QB_ENVIRONMENT)}/app/estimate?txnId=${qbId}`,
        };

        if (matchedLead) {
          matched++;
          const fields = { ...sharedBase, lead_id: matchedLead.id, match_status: 'matched', match_method: 'qb_direct' };
          if (existing) {
            await rda.update('HandoffEstimate', existing.id, fields);
            updated++;
          } else {
            await rda.create('HandoffEstimate', { ...fields, pdf_status: 'pending', pdf_retry_count: 0, source: 'QB Webhook Sync' });
            imported++;
          }
        } else {
          if (existing) {
            await rda.update('HandoffEstimate', existing.id, { ...sharedBase, match_status: 'unmatched', match_method: 'none' });
            updated++;
          } else {
            await rda.create('HandoffEstimate', { ...sharedBase, match_status: 'unmatched', match_method: 'none', pdf_status: 'pending', pdf_retry_count: 0, source: 'QB Webhook Sync - Unmatched' });
            imported++;
          }
        }
      } catch (e) {
        if (e.circuitOpen) {
          console.warn(`[qb-sync-trigger] circuit breaker OPEN — stopping early at ${idx + 1}/${all.length}`);
          stoppedEarly = true;
          break;
        }
        console.error(`[qb-sync-trigger] Error on estimate ${qbEst.DocNumber}:`, e.message);
      }
      if (idx < all.length - 1) await new Promise((r) => setTimeout(r, PACING_MS));
    }

    console.log(`[qb-sync-trigger] done — fetched ${all.length} matched ${matched} imported ${imported} updated ${updated}${stoppedEarly ? ' (stopped early — circuit breaker open)' : ''}`);
  } catch (e) {
    console.error('[qb-sync-trigger] fatal:', e.message);
  }
}

module.exports = { runQbEstimateSyncAsync };