/* eslint-disable no-undef */
/**
 * Handoff Sync Routes — Official REST API version.
 *
 *   POST /handoff/sync-estimates-for-lead   Fetch + match estimates for one lead
 *   POST /handoff/sync-all                   System-wide estimate reconciliation
 *   POST /handoff/sync-projects              Fetch + match projects to leads
 *   POST /handoff/sync-contacts             Fetch + match contacts to leads
 *   POST /handoff/auth/status                Check API key + verify
 *   POST /handoff/auth/store-key              Store hnd_ API key
 *   POST /handoff/auth/disconnect            Remove API key
 *   POST /handoff/auth/diagnose              Connectivity + key diagnostic
 *
 * No GraphQL. No proxy workaround. No Base44. No legacy HANDOFF_AUTH_TOKEN.
 * API key is NEVER logged or returned in any response.
 *
 * Auth: requireProxySecret (X-Proxy-Secret or Railway JWT Bearer).
 * Data: Railway Postgres via rda (no Base44).
 */
'use strict';

const { query } = require('../db/client');

const HANDOFF_REST_BASE = process.env.HANDOFF_REST_BASE_URL || 'https://api.handoff.ai/core/api/v1/integrations';

// ── Settings table helpers ────────────────────────────────────────────────
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

// ── Error classification helper ───────────────────────────────────────────
function classifyHandoffError(e) {
  const msg = String(e.message || '');
  if (msg.indexOf('OFFICIAL_API_KEY_REQUIRED') >= 0) {
    return { status: 401, code: 'OFFICIAL_API_KEY_REQUIRED', message: 'EXTERNAL BLOCKER — OFFICIAL HANDOFF API KEY REQUIRED. Configure HANDOFF_API_KEY env var or store via /handoff/auth/store-key.' };
  }
  if (msg.indexOf('AUTH_DENIED') >= 0) {
    return { status: 401, code: 'AUTH_DENIED', message: 'Handoff API key is invalid or expired. Re-configure in Settings > Integrations > Handoff.' };
  }
  if (msg.indexOf('RATE_LIMITED') >= 0) {
    return { status: 429, code: 'RATE_LIMITED', message: 'Handoff API rate limit exceeded. Retry later.' };
  }
  if (msg.indexOf('TRANSIENT') >= 0) {
    return { status: 502, code: 'TRANSIENT', message: 'Handoff API transient error: ' + msg.slice(0, 200) };
  }
  if (msg.indexOf('NOT_FOUND') >= 0) {
    return { status: 404, code: 'NOT_FOUND', message: msg };
  }
  return { status: 500, code: 'INTERNAL', message: msg };
}

module.exports = function registerHandoffSyncRoutes(app, requireProxySecret, rda, handoffClient) {

  // ── POST /handoff/sync-estimates-for-lead ──────────────────────────────
  app.post('/handoff/sync-estimates-for-lead', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    const { lead_id } = req.body || {};
    if (!lead_id) return res.status(400).json({ success: false, error: 'lead_id required' });

    try {
      // 1. Get API key — clear missing-key error state
      let apiKey;
      try {
        apiKey = await handoffClient.getApiKey();
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      // 2. Load the lead from Railway Postgres
      const leads = await rda.list('Lead', '-created_date', 5000, 0);
      const lead = leads.find(function (l) { return l.id === lead_id || l.railway_lead_id === lead_id; });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

      // 3. Fetch all estimates from Handoff REST API
      let estimates;
      try {
        estimates = await handoffClient.fetchEstimates(apiKey);
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
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

      // 5. Load existing HandoffEstimate records to check for duplicates (idempotency)
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
          estimate_date: est.createdAt ? String(est.createdAt).split('T')[0] : null,
          document_url: est.proposalLink || null,
          document_title: est.name || '',
          last_synced_at: new Date().toISOString(),
          match_status: 'matched',
          match_method: matchResult.method,
          sync_source: 'Handoff',
        };

        // Dedup by handoff_estimate_id (idempotency)
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

      // 7. Update sync cursor
      try {
        const cursorRows = await rda.filter('SyncCursor', { integration: 'handoff' });
        const summary = { fetched: estimates.length, matched: matched.length, created: created, updated: updated };
        if (cursorRows[0]) {
          await rda.update('SyncCursor', cursorRows[0].id, {
            last_successful_sync_at: new Date().toISOString(),
            last_sync_summary: summary,
          });
        }
      } catch (e) { /* non-blocking */ }

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

  // ── POST /handoff/sync-all ─────────────────────────────────────────────
  app.post('/handoff/sync-all', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    try {
      let apiKey;
      try {
        apiKey = await handoffClient.getApiKey();
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      let estimates;
      try {
        estimates = await handoffClient.fetchEstimates(apiKey);
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
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
          estimate_date: est.createdAt ? String(est.createdAt).split('T')[0] : null,
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

  // ── POST /handoff/sync-projects ─────────────────────────────────────────
  app.post('/handoff/sync-projects', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    try {
      let apiKey;
      try {
        apiKey = await handoffClient.getApiKey();
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      let projects;
      try {
        projects = await handoffClient.fetchProjects(apiKey);
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      const leads = await rda.list('Lead', '-created_date', 5000, 0);
      const stats = { fetched: projects.length, matched: 0, updated: 0, unmatched: 0 };

      for (const proj of projects) {
        let matchedLead = null;
        for (const lead of leads) {
          if (handoffClient.matchProjectToLead(proj, lead).match) {
            matchedLead = lead;
            break;
          }
        }

        if (matchedLead) {
          stats.matched++;
          // Update lead with Handoff project info (idempotent — only updates if different)
          const updates = {};
          if (proj.id && matchedLead.handoff_project_id !== proj.id) updates.handoff_project_id = proj.id;
          if (proj.number && matchedLead.handoff_project_number !== proj.number) updates.handoff_project_number = proj.number;
          if (Object.keys(updates).length > 0) {
            await rda.update('Lead', matchedLead.id, updates).catch(function () {});
            stats.updated++;
          }
        } else {
          stats.unmatched++;
        }
      }

      console.log('[handoff] sync-projects: fetched=' + stats.fetched +
        ' matched=' + stats.matched + ' updated=' + stats.updated + ' unmatched=' + stats.unmatched);

      return res.json({ success: true, stats: stats });
    } catch (e) {
      console.error('[handoff] sync-projects error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /handoff/sync-contacts ─────────────────────────────────────────
  app.post('/handoff/sync-contacts', requireProxySecret, async (req, res) => {
    if (!rda.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DATABASE_URL not configured on Railway' });
    }

    try {
      let apiKey;
      try {
        apiKey = await handoffClient.getApiKey();
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      let contacts;
      try {
        contacts = await handoffClient.fetchContacts(apiKey);
      } catch (e) {
        const cls = classifyHandoffError(e);
        return res.status(cls.status).json({ success: false, error: cls.message, code: cls.code });
      }

      const leads = await rda.list('Lead', '-created_date', 5000, 0);
      const stats = { fetched: contacts.length, matched: 0, unmatched: 0 };

      for (const contact of contacts) {
        let matchedLead = null;
        for (const lead of leads) {
          if (handoffClient.matchContactToLead(contact, lead).match) {
            matchedLead = lead;
            break;
          }
        }
        if (matchedLead) stats.matched++;
        else stats.unmatched++;
      }

      console.log('[handoff] sync-contacts: fetched=' + stats.fetched +
        ' matched=' + stats.matched + ' unmatched=' + stats.unmatched);

      return res.json({ success: true, stats: stats });
    } catch (e) {
      console.error('[handoff] sync-contacts error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ═══ Handoff Auth Routes (REST API key — no GraphQL, no phone OTP) ══════

  // POST /handoff/auth/diagnose
  // Comprehensive connectivity + key diagnostic. Tests:
  //   1. Whether a key exists (DB or env)
  //   2. Whether the key is valid (via GET /estimates?limit=1)
  //   3. REST base URL configuration
  // Returns a structured diagnostic report — no key values exposed.
  app.post('/handoff/auth/diagnose', requireProxySecret, async (req, res) => {
    const report = {
      rest_base_url: HANDOFF_REST_BASE,
      key_source: null,
      key_present: false,
      api_reachable: false,
      api_status: null,
      estimates_ok: false,
      estimates_count: 0,
      error: null,
    };

    try {
      // 1. Check key source
      let apiKey = null;
      try {
        const record = await getSetting('handoff_api_key');
        if (record) {
          const rawVal = record.value;
          const keyData = typeof rawVal === 'string' ? JSON.parse(rawVal || '{}') : (rawVal || {});
          if (keyData.api_key) {
            apiKey = keyData.api_key;
            report.key_source = 'database';
            report.key_present = true;
          }
        }
      } catch (e) { /* DB read failed */ }

      if (!apiKey) {
        const envKey = process.env.HANDOFF_API_KEY;
        if (envKey && envKey.trim()) {
          apiKey = envKey.trim();
          report.key_source = 'env_var';
          report.key_present = true;
        }
      }

      if (!apiKey) {
        report.error = 'OFFICIAL_API_KEY_REQUIRED: No Handoff API key in app_settings or HANDOFF_API_KEY env var';
        return res.json(report);
      }

      // 2. Test API connectivity
      try {
        const result = await handoffClient.checkAuth(apiKey);
        report.api_reachable = true;
        report.api_status = result.connected ? 'ok' : 'auth_failed';
        if (result.connected) {
          report.estimates_ok = true;
        } else {
          report.error = 'Key invalid: ' + (result.reason || 'unknown');
        }
        if (result.warning) report.error = result.warning;
      } catch (e) {
        report.error = 'API connectivity test failed: ' + e.message;
        report.api_status = 'error';
      }

      return res.json(report);
    } catch (e) {
      report.error = e.message;
      return res.json(report);
    }
  });

  // POST /handoff/auth/status
  app.post('/handoff/auth/status', requireProxySecret, async (req, res) => {
    try {
      const record = await getSetting('handoff_api_key');
      let apiKey = null;
      let keySource = null;

      if (record) {
        const rawVal = record.value;
        const keyData = typeof rawVal === 'string' ? JSON.parse(rawVal || '{}') : (rawVal || {});
        if (keyData.api_key) {
          apiKey = keyData.api_key;
          keySource = 'database';
        }
      }

      if (!apiKey) {
        const envKey = process.env.HANDOFF_API_KEY;
        if (envKey && envKey.trim()) {
          apiKey = envKey.trim();
          keySource = 'env_var';
        }
      }

      if (!apiKey) {
        return res.json({
          connected: false,
          key_required: true,
          message: 'EXTERNAL BLOCKER — OFFICIAL HANDOFF API KEY REQUIRED',
        });
      }

      // Verify key works against REST API
      const authResult = await handoffClient.checkAuth(apiKey);
      return res.json({
        connected: authResult.connected,
        key_source: keySource,
        connected_at: record ? (typeof record.value === 'string' ? JSON.parse(record.value || '{}') : record.value).connected_at : null,
        warning: authResult.warning || null,
      });
    } catch (e) {
      return res.json({ connected: false, error: e.message });
    }
  });

  // POST /handoff/auth/store-key
  // Body: { api_key: string, skip_verify?: boolean }
  // Stores the hnd_ API key. Never returns the key in the response.
  app.post('/handoff/auth/store-key', requireProxySecret, async (req, res) => {
    const { api_key, skip_verify } = req.body || {};
    if (!api_key || !api_key.trim()) {
      return res.status(400).json({ error: 'api_key required' });
    }

    const cleanKey = api_key.trim();

    if (!skip_verify) {
      // Verify key works against REST API
      try {
        const result = await handoffClient.checkAuth(cleanKey);
        if (!result.connected) {
          return res.status(401).json({
            error: 'Handoff API key verification failed: ' + (result.reason || 'invalid key'),
          });
        }
      } catch (e) {
        return res.status(401).json({ error: 'Handoff API key verification failed: ' + e.message });
      }
    }

    // Store key (never log it)
    const now = new Date().toISOString();
    const keyValue = { api_key: cleanKey, connected_at: now, last_verified_at: now };
    await upsertSetting('handoff_api_key', keyValue, 'text');

    return res.json({ success: true, message: 'API key saved successfully', connected: true, verified: !skip_verify });
  });

  // POST /handoff/auth/disconnect
  app.post('/handoff/auth/disconnect', requireProxySecret, async (req, res) => {
    try {
      await deleteSetting('handoff_api_key');
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

};