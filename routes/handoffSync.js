/* eslint-disable no-undef */
/**
 * Handoff Sync Routes - Railway CRM Handoff integration.
 *
 *   POST /handoff/sync-estimates-for-lead   Fetch + match estimates for one lead
 *   POST /handoff/sync-all                   System-wide reconciliation
 *   POST /handoff/diagnose-lead-estimates    Diagnostic matching info
 *   POST /handoff/auth/status                Check connection
 *   POST /handoff/auth/login                 Initiate phone OTP
 *   POST /handoff/auth/verify                Verify OTP + store token
 *   POST /handoff/auth/store-token           Manually store API key/token
 *   POST /handoff/auth/disconnect            Remove token
 *
 * Auth: requireProxySecret (X-Proxy-Secret or Railway JWT Bearer).
 * Data: Railway Postgres via rda (no Base44).
 */
'use strict';

const { query } = require('../db/client');

const HANDOFF_API = process.env.HANDOFF_API_BASE_URL || 'https://app.handoff.ai';

// ── Settings table helpers (replaces rda for Property/key-value storage) ────
// The Base44 "Property" entity is a key-value store. In Railway, the `settings`
// table serves this purpose (key, value JSONB, type). We use `query` directly
// because rda's update/delete use `id` but settings uses `key` as the unique ID.
async function getSetting(key) {
  const { rows } = await query('SELECT * FROM app_settings WHERE key = $1', [key]);
  return rows[0] || null;
}

async function upsertSetting(key, value, type) {
  const { rows } = await query(
    `INSERT INTO app_settings (key, value, type)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, type = COALESCE($3, app_settings.type), updated_at = NOW()
     RETURNING *`,
    [key, JSON.stringify(value), type || 'text']
  );
  return rows[0];
}

async function deleteSetting(key) {
  await query('DELETE FROM app_settings WHERE key = $1', [key]);
}

module.exports = function registerHandoffSyncRoutes(app, requireProxySecret, rda, handoffClient) {

  // ── POST /handoff/sync-estimates-for-lead ──────────────────────────────────
  app.post('/handoff/sync-estimates-for-lead', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    const { lead_id } = req.body || {};
    if (!lead_id) return res.status(400).json({ success: false, error: 'lead_id required' });

    try {
      // 1. Get a valid Handoff token
      let token;
      try {
        token = await handoffClient.getValidToken();
      } catch (e) {
        return res.status(401).json({ success: false, error: 'Handoff not authenticated: ' + e.message });
      }

      // 2. Load the lead from Railway Postgres
      const leads = await rda.list('Lead', '-created_date', 5000, 0);
      const lead = leads.find(function (l) { return l.id === lead_id || l.railway_lead_id === lead_id; });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      // 3. Fetch all estimates from Handoff API
      let estimates;
      try {
        estimates = await handoffClient.fetchAllEstimates(token);
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.indexOf('AUTH_DENIED') >= 0 || msg.indexOf('NOT_AUTHENTICATED') >= 0) {
          return res.status(401).json({
            success: false,
            error: 'Handoff credential expired or invalid. Re-authenticate in Settings > Integrations > Handoff.'
          });
        }
        return res.status(502).json({ success: false, error: 'Handoff API error: ' + msg });
      }

      // 4. Match estimates to this lead
      const matched = estimates.filter(function (est) {
        return handoffClient.matchEstimateToLead(est, lead).match;
      });

      if (matched.length === 0) {
        return res.json({
          success: true,
          message: 'No Handoff estimates found for this lead (searched ' + estimates.length + ' estimates)',
          total_fetched: estimates.length,
          matched: 0,
          created: 0,
          updated: 0,
        });
      }

      // 5. Load existing HandoffEstimate records to check for duplicates
      const existingEstimates = await rda.filter('HandoffEstimate', { lead_id: lead.id });

      let created = 0, updated = 0;
      for (const est of matched) {
        const matchResult = handoffClient.matchEstimateToLead(est, lead);
        const handoffEstimateId = String(est.id);
        const estimateData = {
          handoff_estimate_id: handoffEstimateId,
          handoff_estimate_number: est.name || handoffEstimateId,
          lead_id: lead.id,
          customer_name: est.clientName || (lead.first_name + ' ' + lead.last_name),
          customer_phone: est.clientPhone || lead.phone || '',
          customer_email: est.clientEmail || lead.email || '',
          estimate_amount: est.total || 0,
          estimate_status: est.state || 'DRAFT',
          estimate_date: est.createdAt ? est.createdAt.split('T')[0] : null,
          document_url: est.proposalLink || null,
          document_title: est.name || '',
          last_synced_at: new Date().toISOString(),
          match_status: 'matched',
          match_method: matchResult.method,
          sync_source: 'Handoff',
        };

        // Check for existing record by handoff_estimate_id (deduplication)
        const existing = existingEstimates.find(function (e) {
          return e.handoff_estimate_id === handoffEstimateId;
        });

        if (existing) {
          await rda.update('HandoffEstimate', existing.id, estimateData);
          updated++;
        } else {
          await rda.create('HandoffEstimate', Object.assign({}, estimateData, {
            pdf_status: 'pending',
            pdf_retry_count: 0,
            source: 'Handoff',
          }));
          created++;

          // Log activity
          const amtStr = est.total > 0
            ? ' (' + Number(est.total).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')'
            : '';
          await rda.create('Activity', {
            lead_id: lead.id,
            type: 'note',
            timestamp: new Date().toISOString(),
            content: 'Handoff estimate ' + (est.name || '#' + est.id) + amtStr + ' synced. Status: ' + (est.state || 'DRAFT'),
            author: 'Handoff Sync',
            source: 'manual',
          }).catch(function () {});
        }
      }

      // 6. Update lead handoff_estimate_status if awaiting_qb
      if (lead.handoff_estimate_status === 'awaiting_qb') {
        await rda.update('Lead', lead.id, { handoff_estimate_status: 'synced' }).catch(function () {});
      }

      console.log('[handoff] sync-estimates-for-lead: fetched=' + estimates.length +
        ' matched=' + matched.length + ' created=' + created + ' updated=' + updated);

      return res.json({
        success: true,
        message: 'Found ' + matched.length + ' Handoff estimate(s): ' + created + ' new, ' + updated + ' updated',
        total_fetched: estimates.length,
        matched: matched.length,
        created: created,
        updated: updated,
      });
    } catch (e) {
      console.error('[handoff] sync-estimates-for-lead error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /handoff/sync-all ──────────────────────────────────────────────────
  app.post('/handoff/sync-all', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    try {
      let token;
      try {
        token = await handoffClient.getValidToken();
      } catch (e) {
        return res.status(401).json({ success: false, error: 'Handoff not authenticated: ' + e.message });
      }

      let estimates;
      try {
        estimates = await handoffClient.fetchAllEstimates(token);
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.indexOf('AUTH_DENIED') >= 0 || msg.indexOf('NOT_AUTHENTICATED') >= 0) {
          return res.status(401).json({
            success: false,
            error: 'Handoff credential expired or invalid. Re-authenticate in Settings > Integrations > Handoff.'
          });
        }
        return res.status(502).json({ success: false, error: 'Handoff API error: ' + msg });
      }

      // Load all leads and existing estimates
      const [leads, existingEstimates] = await Promise.all([
        rda.list('Lead', '-created_date', 5000, 0),
        rda.list('HandoffEstimate', '-created_date', 5000, 0),
      ]);

      const stats = { fetched: estimates.length, matched: 0, created: 0, updated: 0, unmatched: 0 };

      for (const est of estimates) {
        const handoffEstimateId = String(est.id);
        const existing = existingEstimates.find(function (e) {
          return e.handoff_estimate_id === handoffEstimateId;
        });

        // Try to match to a lead
        let matchedLead = null;
        for (const lead of leads) {
          if (handoffClient.matchEstimateToLead(est, lead).match) {
            matchedLead = lead;
            break;
          }
        }

        const baseData = {
          handoff_estimate_id: handoffEstimateId,
          handoff_estimate_number: est.name || handoffEstimateId,
          customer_name: est.clientName || '',
          customer_phone: est.clientPhone || '',
          customer_email: est.clientEmail || '',
          estimate_amount: est.total || 0,
          estimate_status: est.state || 'DRAFT',
          estimate_date: est.createdAt ? est.createdAt.split('T')[0] : null,
          document_url: est.proposalLink || null,
          document_title: est.name || '',
          last_synced_at: new Date().toISOString(),
          sync_source: 'Handoff',
        };

        if (matchedLead) {
          stats.matched++;
          const matchResult = handoffClient.matchEstimateToLead(est, matchedLead);
          const matchedData = Object.assign({}, baseData, {
            lead_id: matchedLead.id,
            match_status: 'matched',
            match_method: matchResult.method,
          });

          if (existing) {
            await rda.update('HandoffEstimate', existing.id, matchedData);
            stats.updated++;
          } else {
            await rda.create('HandoffEstimate', Object.assign({}, matchedData, {
              pdf_status: 'pending', pdf_retry_count: 0, source: 'Handoff',
            }));
            stats.created++;
          }
        } else {
          stats.unmatched++;
          const unmatchedData = Object.assign({}, baseData, {
            match_status: 'unmatched',
            match_method: 'none',
          });

          if (existing) {
            await rda.update('HandoffEstimate', existing.id, unmatchedData);
            stats.updated++;
          } else {
            await rda.create('HandoffEstimate', Object.assign({}, unmatchedData, {
              pdf_status: 'pending', pdf_retry_count: 0, source: 'Handoff - Unmatched',
            }));
            stats.created++;
          }
        }
      }

      // Update sync cursor
      try {
        const cursorRows = await rda.filter('SyncCursor', { integration: 'handoff' });
        const summary = {
          fetched: stats.fetched, imported: stats.created, updated: stats.updated,
          matched: stats.matched, unmatched: stats.unmatched,
        };
        if (cursorRows[0]) {
          await rda.update('SyncCursor', cursorRows[0].id, {
            last_successful_sync_at: new Date().toISOString(),
            last_sync_summary: summary,
          });
        } else {
          await rda.create('SyncCursor', {
            integration: 'handoff',
            last_successful_sync_at: new Date().toISOString(),
            last_sync_summary: summary,
          });
        }
      } catch (e) {
        console.warn('[handoff] cursor save failed:', e.message);
      }

      console.log('[handoff] sync-all: fetched=' + stats.fetched +
        ' matched=' + stats.matched + ' created=' + stats.created +
        ' updated=' + stats.updated + ' unmatched=' + stats.unmatched);

      return res.json({ success: true, stats: stats });
    } catch (e) {
      console.error('[handoff] sync-all error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /handoff/diagnose-lead-estimates ──────────────────────────────────
  app.post('/handoff/diagnose-lead-estimates', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    const { lead_id } = req.body || {};
    if (!lead_id) return res.status(400).json({ success: false, error: 'lead_id required' });

    try {
      let token;
      try {
        token = await handoffClient.getValidToken();
      } catch (e) {
        return res.status(401).json({ success: false, error: 'Handoff not authenticated: ' + e.message });
      }

      const leads = await rda.list('Lead', '-created_date', 5000, 0);
      const lead = leads.find(function (l) { return l.id === lead_id || l.railway_lead_id === lead_id; });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      let estimates;
      try {
        estimates = await handoffClient.fetchAllEstimates(token);
      } catch (e) {
        return res.status(502).json({ success: false, error: 'Handoff API error: ' + e.message });
      }

      const diagnostics = estimates.map(function (est) {
        const result = handoffClient.matchEstimateToLead(est, lead);
        return {
          id: est.id,
          name: est.name,
          state: est.state,
          total: est.total,
          clientName: est.clientName,
          clientPhone: est.clientPhone,
          clientEmail: est.clientEmail,
          match: result.match,
          method: result.method,
        };
      });

      const matched = diagnostics.filter(function (d) { return d.match; });

      return res.json({
        success: true,
        lead: {
          id: lead.id, first_name: lead.first_name, last_name: lead.last_name,
          phone: lead.phone, email: lead.email,
        },
        total_estimates: estimates.length,
        matched_count: matched.length,
        matched: matched,
        all_estimates: diagnostics.slice(0, 20),
      });
    } catch (e) {
      console.error('[handoff] diagnose error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ═══ Handoff Auth Routes (migrated from Base44 handoffAuth function) ════════

  // POST /handoff/auth/status
  app.post('/handoff/auth/status', requireProxySecret, async (req, res) => {
    try {
      const record = await getSetting('handoff_bearer_token');
      if (!record) {
        return res.json({ connected: false });
      }
      // Handle JSONB auto-parsing by pg (value may be object or string)
      const rawVal = record.value;
      const tokenData = typeof rawVal === 'string' ? JSON.parse(rawVal || '{}') : (rawVal || {});
      const token = tokenData.token;
      if (!token) return res.json({ connected: false });

      // Verify token is still valid — use /graphql with Bearer (the canonical
      // path that worked in Base44 production). A 403 here means WAF blocking,
      // not an expired token — don't mark expired for WAF blocks.
      const testRes = await fetch(HANDOFF_API + '/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (testRes.status === 403) return res.json({ connected: true, connected_at: tokenData.connected_at || null, waf_blocked: true });
      if (!testRes.ok) return res.json({ connected: false, expired: true });

      const testData = await testRes.json();
      if (testData.errors && testData.errors.length) {
        return res.json({ connected: false, expired: true });
      }

      return res.json({
        connected: true,
        connected_at: tokenData.connected_at || null,
      });
    } catch (e) {
      return res.json({ connected: false, error: e.message });
    }
  });

  // POST /handoff/auth/login
  app.post('/handoff/auth/login', requireProxySecret, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Phone number required' });

    try {
      const loginRes = await fetch(HANDOFF_API + '/auth/phone/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      if (!loginRes.ok) {
        const txt = await loginRes.text();
        return res.status(loginRes.status).json({
          error: 'Handoff API returned ' + loginRes.status + ': ' + txt.substring(0, 200),
        });
      }
      return res.json({ success: true, message: 'Verification code sent to your phone' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /handoff/auth/verify
  app.post('/handoff/auth/verify', requireProxySecret, async (req, res) => {
    const { phone, code } = req.body || {};
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone number and verification code required' });
    }

    try {
      const verifyRes = await fetch(HANDOFF_API + '/auth/phone/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const verifyText = await verifyRes.text();
      if (!verifyRes.ok) {
        return res.status(verifyRes.status).json({
          error: 'Handoff API returned ' + verifyRes.status + ': ' + verifyText.substring(0, 200),
        });
      }

      let verifyData;
      try {
        verifyData = JSON.parse(verifyText);
      } catch {
        return res.status(500).json({ error: 'Invalid response from Handoff API' });
      }

      const token = verifyData.token || verifyData.access_token;
      if (!token) return res.status(401).json({ error: 'No authentication token received' });

      // Store token in Property entity
      const cleanToken = token.trim().startsWith('Bearer ') ? token.trim().slice(7) : token.trim();
      const now = new Date().toISOString();
      const tokenValue = JSON.stringify({
        token: cleanToken,
        phone: phone.trim(),
        connected_at: now,
        last_verified_at: now,
      });

      await upsertSetting('handoff_bearer_token', JSON.parse(tokenValue), 'text');

      return res.json({ success: true, message: 'Successfully authenticated with Handoff' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /handoff/auth/test-connectivity — test if the Railway proxy can reach the Handoff API
  app.post('/handoff/auth/test-connectivity', requireProxySecret, async (req, res) => {
    try {
      const testRes = await fetch(HANDOFF_API + '/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      const text = await testRes.text();
      return res.json({
        reachable: testRes.ok,
        status: testRes.status,
        content_type: testRes.headers.get('content-type'),
        body_preview: text.substring(0, 300),
        is_json: text.startsWith('{'),
        handoff_api_url: HANDOFF_API,
      });
    } catch (e) {
      return res.json({ reachable: false, error: e.message, handoff_api_url: HANDOFF_API });
    }
  });

  // POST /handoff/auth/store-token
  // Body: { token: string, skip_verify?: boolean }
  // When skip_verify is true, stores the token without calling the Handoff API
  // (useful when the Handoff API WAF blocks Railway IPs but the token is known valid).
  app.post('/handoff/auth/store-token', requireProxySecret, async (req, res) => {
    const { token, skip_verify } = req.body || {};
    if (!token || !token.trim()) return res.status(400).json({ error: 'Token required' });

    const cleanToken = token.trim().startsWith('Bearer ') ? token.trim().slice(7) : token.trim();

    if (!skip_verify) {
      // Verify token works — use /graphql with Bearer (canonical path)
      const verifyRes = await fetch(HANDOFF_API + '/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cleanToken,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (!verifyRes.ok) {
        const txt = await verifyRes.text();
        return res.status(401).json({
          error: 'Handoff API error (' + verifyRes.status + '): ' + txt.substring(0, 200),
        });
      }
      const verifyData = await verifyRes.json();
      if (verifyData.errors && verifyData.errors.length) {
        return res.status(401).json({ error: 'Handoff API error: ' + verifyData.errors[0].message });
      }
    }

    // Store token
    const now = new Date().toISOString();
    const tokenValue = JSON.stringify({ token: cleanToken, connected_at: now, last_verified_at: now });
    await upsertSetting('handoff_bearer_token', JSON.parse(tokenValue), 'text');

    return res.json({ success: true, message: 'Token saved successfully', connected: true, verified: !skip_verify });
  });

  // POST /handoff/auth/disconnect
  app.post('/handoff/auth/disconnect', requireProxySecret, async (req, res) => {
    try {
      await deleteSetting('handoff_bearer_token');
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

};