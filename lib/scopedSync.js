/* eslint-disable no-undef */
'use strict';
// Scoped QuickBooks sync endpoints (Railway). Reuses the deployed batch matching
// system (getAllQuickBooksEstimates, getQuickBooksCustomer, qbMatch.findMatchingLead)
// and the R2 upload path. Writes to the Railway handoff_estimates table directly.
// Never touches the global batch SyncCursor. No Base44 dependency.
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const rda = require('./railwayDataAccess');
const qbMatch = require('./qbMatch');

function safeMsg(e) {
  return String((e && e.message) || 'Internal error').slice(0, 300);
}
function qbAppUrl(qbEstimateId, qbEnvironment) {
  const host = qbEnvironment === 'production' ? 'qbo' : 'sandbox.qbo';
  return 'https://' + host + '.intuit.com/app/estimate?txnId=' + qbEstimateId;
}
function detectRule(customer, lead) {
  const rawName = customer.DisplayName || customer.name || '';
  const phone = qbMatch.normalizePhone(customer.PrimaryPhone ? customer.PrimaryPhone.FreeFormNumber : (customer.phone || ''));
  const email = qbMatch.normalizeEmail(customer.PrimaryEmailAddr ? customer.PrimaryEmailAddr.Address : (customer.email || ''));
  const addr = qbMatch.normalizeString(qbMatch.normalize(customer.BillAddr ? customer.BillAddr.Line1 : (customer.property_address || '')));
  const lPhone = qbMatch.normalizePhone(lead.phone || '');
  const lEmail = qbMatch.normalizeEmail(lead.email || '');
  const lAddr = qbMatch.normalizeString(qbMatch.normalize(lead.property_address || ''));
  if (phone && lPhone === phone && qbMatch.partialNameMatch(rawName, lead.first_name, lead.last_name)) return 'phone+name';
  if (email && lEmail === email && qbMatch.partialNameMatch(rawName, lead.first_name, lead.last_name)) return 'email+name';
  if (phone && lPhone === phone) return 'phone';
  if (email && lEmail === email) return 'email';
  if (addr && addr.length >= 10 && lAddr.length >= 10 && lAddr.slice(0, 30) === addr.slice(0, 30) && qbMatch.partialNameMatch(rawName, lead.first_name, lead.last_name)) return 'address+name';
  const nameNorm = qbMatch.normalizeString(qbMatch.normalize(qbMatch.extractCustomerName(rawName)));
  const leadNameNorm = qbMatch.normalizeString(qbMatch.normalize((lead.first_name || '') + ' ' + (lead.last_name || '')));
  if (nameNorm && nameNorm === leadNameNorm) return 'exact-name';
  return 'unknown';
}

module.exports = {
  register: function (app, deps) {
    const requireProxySecret = deps.requireProxySecret;
    const qbQuery = deps.qbQuery;
    const refreshTokenIfNeeded = deps.refreshTokenIfNeeded;
    const QB_API_BASE = deps.QB_API_BASE;
    const QB_ENVIRONMENT = deps.QB_ENVIRONMENT;
    const s3Client = deps.s3Client;
    const activeBucket = deps.activeBucket;
    const activePublicUrl = deps.activePublicUrl;
    const getAllQuickBooksEstimates = deps.getAllQuickBooksEstimates;
    const getQuickBooksCustomer = deps.getQuickBooksCustomer;

    app.post('/sync/lead-estimates', requireProxySecret, async (req, res) => {
      const reqId = Date.now().toString(36);
      const t0 = Date.now();
      try {
        const leadId = (req.body || {}).leadId;
        if (!leadId || typeof leadId !== 'string') return res.status(400).json({ ok: false, error: 'leadId is required' });
        if (!rda.isConfigured()) return res.status(503).json({ ok: false, error: 'Railway database is not configured for sync' });
        let lead = null;
        try { lead = await rda.get('Lead', leadId); } catch (e) { lead = null; }
        if (!lead) {
          console.log('[scoped:' + reqId + '] lead-estimates 404 leadId=' + leadId);
          return res.status(404).json({ ok: false, error: 'Lead not found' });
        }
        const leadPk = lead.id;
        const estimates = await getAllQuickBooksEstimates();
        const existing = await rda.filter('HandoffEstimate', { lead_id: leadPk });
        const existingByQbId = new Map((existing || []).filter(Boolean).map(function (r) { return [String(r.qb_estimate_id || ''), r]; }));
        let created = 0, updated = 0, unchanged = 0, matchedCustomer = false;
        for (const estimate of estimates) {
          const qbEstimateId = estimate.Id || estimate.id;
          if (!qbEstimateId) continue;
          const customer = await getQuickBooksCustomer(estimate.CustomerRef);
          const matched = customer ? qbMatch.findMatchingLead(customer, [lead]) : null;
          if (!matched) continue;
          matchedCustomer = true;
          const qbIdStr = String(qbEstimateId);
          const now = new Date().toISOString();
          const qbUpdatedAt = (estimate.MetaData && estimate.MetaData.LastUpdatedTime) || null;
          const existingRec = existingByQbId.get(qbIdStr);
          const payload = {
            qb_estimate_id: qbIdStr,
            qb_estimate_number: estimate.DocNumber || null,
            customer_name: (customer && customer.DisplayName) || (estimate.CustomerRef && estimate.CustomerRef.name) || null,
            customer_email: (customer && customer.PrimaryEmailAddr && customer.PrimaryEmailAddr.Address) || null,
            customer_phone: (customer && customer.PrimaryPhone && customer.PrimaryPhone.FreeFormNumber) || null,
            estimate_amount: estimate.TotalAmt != null ? estimate.TotalAmt : null,
            estimate_status: estimate.TxnStatus || (estimate.Balance === 0 ? 'paid' : 'open'),
            estimate_date: estimate.TxnDate || null,
            lead_id: leadPk,
            last_synced_at: now,
            sync_source: 'QuickBooks',
            source: 'Railway scoped sync',
            match_status: 'matched',
            match_method: 'qb_direct',
            qb_app_url: qbAppUrl(qbIdStr, QB_ENVIRONMENT),
          };
          if (existingRec) {
            const prevSynced = existingRec.last_synced_at ? new Date(existingRec.last_synced_at).getTime() : 0;
            const qbT = qbUpdatedAt ? new Date(qbUpdatedAt).getTime() : 0;
            if (qbT && prevSynced && qbT <= prevSynced) { unchanged += 1; }
            else { await rda.update('HandoffEstimate', existingRec.id, payload); updated += 1; }
          } else {
            const createPayload = Object.assign({}, payload, { pdf_status: 'pending', pdf_retry_count: 0 });
            await rda.create('HandoffEstimate', createPayload);
            created += 1;
          }
        }
        const dur = Date.now() - t0;
        console.log('[scoped:' + reqId + '] lead-estimates lead=' + leadPk + ' matchedCustomer=' + matchedCustomer + ' created=' + created + ' updated=' + updated + ' unchanged=' + unchanged + ' dur=' + dur + 'ms');
        return res.json({ success: true, leadId: leadPk, matchedCustomer: matchedCustomer, estimatesFound: created + updated + unchanged, created: created, updated: updated, unchanged: unchanged, warnings: [] });
      } catch (e) {
        console.error('[scoped:' + reqId + '] lead-estimates error: ' + safeMsg(e));
        return res.status(500).json({ ok: false, error: safeMsg(e) });
      }
    });

    app.post('/sync/diagnose-lead', requireProxySecret, async (req, res) => {
      const reqId = Date.now().toString(36);
      const t0 = Date.now();
      try {
        const leadId = (req.body || {}).leadId;
        if (!leadId || typeof leadId !== 'string') return res.status(400).json({ ok: false, error: 'leadId is required' });
        if (!rda.isConfigured()) return res.status(503).json({ ok: false, error: 'Railway database is not configured' });
        let lead = null;
        try { lead = await rda.get('Lead', leadId); } catch (e) { lead = null; }
        if (!lead) {
          console.log('[scoped:' + reqId + '] diagnose-lead 404 leadId=' + leadId);
          return res.status(404).json({ ok: false, error: 'Lead not found' });
        }
        const leadMatchData = {
          name: ((lead.first_name || '') + ' ' + (lead.last_name || '')).trim(),
          phone: lead.phone || null,
          email: lead.email || null,
          address: lead.property_address || null,
          handoff_project_number: lead.handoff_project_number || null,
        };
        const estimates = await getAllQuickBooksEstimates();
        const candidates = [];
        let selectedCustomer = null, matchingRule = null;
        const estimateList = [];
        for (const estimate of estimates) {
          const customer = await getQuickBooksCustomer(estimate.CustomerRef);
          if (!customer) continue;
          const matched = qbMatch.findMatchingLead(customer, [lead]);
          if (!matched) continue;
          candidates.push({
            id: customer.Id || null,
            displayName: customer.DisplayName || null,
            email: (customer.PrimaryEmailAddr && customer.PrimaryEmailAddr.Address) || null,
            phone: (customer.PrimaryPhone && customer.PrimaryPhone.FreeFormNumber) || null,
          });
          if (!selectedCustomer) {
            selectedCustomer = candidates[candidates.length - 1];
            matchingRule = detectRule(customer, lead);
            const cid = customer.Id;
            if (cid) {
              const ests = await qbQuery("SELECT * FROM Estimate WHERE CustomerRef = '" + cid + "' MAXRESULTS 100");
              const arr = (ests && ests.QueryResponse && ests.QueryResponse.Estimate) || [];
              for (const e2 of arr) {
                estimateList.push({ id: e2.Id, docNumber: e2.DocNumber, amount: e2.TotalAmt != null ? e2.TotalAmt : null, status: e2.TxnStatus || (e2.Balance === 0 ? 'paid' : 'open'), date: e2.TxnDate || null });
              }
            }
          }
        }
        const warnings = [];
        if (!selectedCustomer) warnings.push('No matching QuickBooks customer or estimate found');
        const dur = Date.now() - t0;
        console.log('[scoped:' + reqId + '] diagnose-lead lead=' + lead.id + ' candidates=' + candidates.length + ' rule=' + matchingRule + ' estimates=' + estimateList.length + ' dur=' + dur + 'ms (read-only)');
        return res.json({ success: true, leadId: lead.id, leadMatchData: leadMatchData, customerCandidates: candidates, selectedCustomer: selectedCustomer, matchingRule: matchingRule, estimates: estimateList, warnings: warnings });
      } catch (e) {
        console.error('[scoped:' + reqId + '] diagnose-lead error: ' + safeMsg(e));
        return res.status(500).json({ ok: false, error: safeMsg(e) });
      }
    });

    app.post('/sync/estimate-pdf', requireProxySecret, async (req, res) => {
      const reqId = Date.now().toString(36);
      const t0 = Date.now();
      try {
        if (!rda.isConfigured()) return res.status(503).json({ ok: false, error: 'Railway database is not configured' });
        const body = req.body || {};
        const estimateId = body.estimateId;
        const crmEstimateId = body.crmEstimateId;
        const force = body.force === true;
        if (!estimateId && !crmEstimateId) return res.status(400).json({ ok: false, error: 'estimateId or crmEstimateId is required' });
        if (!s3Client || !activeBucket) return res.status(503).json({ ok: false, error: 'File storage (R2/S3) is not configured on the server' });
        let rec = null;
        if (crmEstimateId) {
          try { rec = await rda.get('HandoffEstimate', crmEstimateId); } catch (e) { rec = null; }
          if (!rec) {
            console.log('[scoped:' + reqId + '] estimate-pdf 404 crmEstimateId=' + crmEstimateId);
            return res.status(404).json({ ok: false, error: 'Estimate record not found' });
          }
        }
        if (!rec && estimateId) {
          const found = await rda.filter('HandoffEstimate', { qb_estimate_id: String(estimateId) });
          rec = (found && found[0]) || null;
          if (!rec) {
            console.log('[scoped:' + reqId + '] estimate-pdf 404 estimateId=' + estimateId + ' (no CRM record)');
            return res.status(404).json({ ok: false, error: 'Estimate record not found for this QuickBooks estimate ID' });
          }
        }
        const recId = rec.id;
        const qbId = rec.qb_estimate_id || estimateId;
        if (!qbId) return res.status(404).json({ ok: false, error: 'No QuickBooks estimate linked to this record' });
        if (!force && rec.pdf_status === 'ready' && rec.pdf_url) {
          console.log('[scoped:' + reqId + '] estimate-pdf alreadyCurrent qb=' + qbId);
          return res.json({ success: true, estimateId: String(qbId), downloaded: false, alreadyCurrent: true, fileUrl: rec.pdf_url, warnings: [] });
        }
        const tokens = await refreshTokenIfNeeded();
        const url = QB_API_BASE + '/' + tokens.realm_id + '/estimate/' + qbId + '/pdf?minorversion=65';
        const pdfRes = await fetch(url, { headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/pdf' } });
        const contentType = pdfRes.headers.get('content-type') || '';
        if (!pdfRes.ok || contentType.indexOf('pdf') === -1) {
          console.warn('[scoped:' + reqId + '] estimate-pdf fetch failed qb=' + qbId + ' status=' + pdfRes.status + ' ct=' + contentType.slice(0, 40));
          return res.status(502).json({ ok: false, error: 'PDF fetch failed: ' + pdfRes.status });
        }
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        if (!buf || buf.length === 0) return res.status(502).json({ ok: false, error: 'PDF response was empty' });
        const key = 'estimates/' + qbId + '/estimate.pdf';
        await s3Client.send(new PutObjectCommand({ Bucket: activeBucket, Key: key, Body: buf, ContentType: 'application/pdf', ContentDisposition: 'inline; filename="estimate-' + qbId + '.pdf"' }));
        const fileUrl = activePublicUrl ? activePublicUrl + '/' + key : key;
        const now = new Date().toISOString();
        await rda.update('HandoffEstimate', recId, {
          pdf_url: fileUrl,
          document_url: fileUrl,
          pdf_status: 'ready',
          pdf_fetched_at: now,
          qb_app_url: qbAppUrl(String(qbId), QB_ENVIRONMENT),
        });
        const dur = Date.now() - t0;
        console.log('[scoped:' + reqId + '] estimate-pdf downloaded qb=' + qbId + ' bytes=' + buf.length + ' dur=' + dur + 'ms');
        return res.json({ success: true, estimateId: String(qbId), downloaded: true, alreadyCurrent: false, fileUrl: fileUrl, warnings: [] });
      } catch (e) {
        console.error('[scoped:' + reqId + '] estimate-pdf error: ' + safeMsg(e));
        return res.status(500).json({ ok: false, error: safeMsg(e) });
      }
    });
  },
};