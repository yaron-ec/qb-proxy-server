/* eslint-disable no-undef */
/**
 * qbSyncTrigger — Async QB estimate sync trigger for webhook receivers.
 *
 * Extracted from server.js so the QB webhook receiver can trigger a sync
 * without a circular dependency on server.js.
 *
 * Calls the same fetchAllQbEstimates + qbMatch logic as the server.js
 * runQbEstimateSync, but as a fire-and-forget async operation.
 */
'use strict';

const rda = require('./railwayDataAccess');
const qbMatch = require('./qbMatch');

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

    // Load QB tokens from the filesystem (same as server.js)
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const TOKEN_FILE = path.join(__dirname, '..', '.qb-tokens.encrypted');
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set');

    function decryptToken(encryptedData) {
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
      const [ivHex, encrypted] = encryptedData.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return JSON.parse(decrypted);
    }

    let storedTokens = null;
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        storedTokens = decryptToken(fs.readFileSync(TOKEN_FILE, 'utf8'));
      }
    } catch (e) { console.warn('[qb-sync-trigger] token load failed:', e.message); }

    if (!storedTokens) {
      console.warn('[qb-sync-trigger] No QB tokens — skipping sync');
      return;
    }

    // Simple token refresh check
    const isExpired = !storedTokens.expires_at || Date.now() >= new Date(storedTokens.expires_at).getTime() - 5 * 60 * 1000;
    if (isExpired) {
      const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
      const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
      const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
      const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: storedTokens.refresh_token }).toString(),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(`Token refresh failed: ${tokenData.error_description || tokenData.error}`);
      storedTokens = {
        ...storedTokens,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || storedTokens.refresh_token,
        expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      };
      // Save refreshed tokens
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let enc = cipher.update(JSON.stringify(storedTokens), 'utf8', 'hex');
      enc += cipher.final('hex');
      fs.writeFileSync(TOKEN_FILE, iv.toString('hex') + ':' + enc, 'utf8');
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