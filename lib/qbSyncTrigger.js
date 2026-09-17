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
 * Token source: lib/qbInboundSync.js's getValidTokens() — the canonical
 * Postgres-backed credential store (lib/qbTokenStore.js), the SAME store
 * server.js's own mutexed refresh reads/writes. This module previously
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
const { getValidTokens } = require('./qbInboundSync');

const QB_API_BASE = (process.env.QB_ENVIRONMENT === 'production')
  ? 'https://quickbooks.api.intuit.com/v3/company'
  : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

const SANDBOX = process.env.QB_SANDBOX === 'true';

let _syncing = false;

async function runQbEstimateSyncAsync() {
  if (_syncing) {
    console.log('[qb-sync-trigger] Sync already in progress — skipping');
    return;
  }
  _syncing = true;
  try {
    if (!rda.isConfigured()) throw new Error('DATABASE_URL not configured');

    const storedTokens = await getValidTokens();
    if (!storedTokens) {
      console.warn('[qb-sync-trigger] No QB tokens — skipping sync');
      return;
    }

    async function qbQuery(q) {
      const url = `${QB_API_BASE}/${storedTokens.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=65`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${storedTokens.access_token}`, Accept: 'application/json' },
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { raw: text }; }
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

    let matched = 0, imported = 0, updated = 0;

    for (const qbEst of all) {
      try {
        const qbId = qbEst.Id;
        const customerId = qbEst.CustomerRef?.value;
        const customerRefName = qbEst.CustomerRef?.name || '(Unknown)';

        // Fetch customer for email/phone
        let fullCustomer = {};
        try {
          const custData = await fetch(`${QB_API_BASE}/${storedTokens.realm_id}/customer/${customerId}?minorversion=65`, {
            headers: { Authorization: `Bearer ${storedTokens.access_token}`, Accept: 'application/json' },
          }).then(r => r.json());
          fullCustomer = custData?.Customer || {};
        } catch (e) { /* best-effort */ }

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
          qb_app_url: `${SANDBOX ? 'https://sandbox.qbo.intuit.com' : 'https://app.qbo.intuit.com'}/app/estimate?txnId=${qbId}`,
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
        console.error(`[qb-sync-trigger] Error on estimate ${qbEst.DocNumber}:`, e.message);
      }
    }

    console.log(`[qb-sync-trigger] done — fetched ${all.length} matched ${matched} imported ${imported} updated ${updated}`);
  } catch (e) {
    console.error('[qb-sync-trigger] fatal:', e.message);
  } finally {
    _syncing = false;
  }
}

module.exports = { runQbEstimateSyncAsync };