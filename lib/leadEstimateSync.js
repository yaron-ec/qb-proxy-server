/* eslint-disable no-undef */
/**
 * leadEstimateSync — the ONE lead-scoped QuickBooks estimate sync
 * implementation, extracted from routes/leadQB.js's existing
 * POST /by-external/:externalRef/sync-estimates handler so it can be
 * reused by BOTH that route (admin/manager-triggered, allowFullScan: true
 * — unchanged behavior) AND the new automatic post-appointment sync job
 * (lib/postAppointmentEstimateSync.js, allowFullScan: false by default).
 *
 * allowFullScan gates ONLY step 2c below (the "fetch every QB estimate and
 * fuzzy-match" fallback) — the one genuinely expensive, full-company QB
 * call in this function. The automated per-appointment job deliberately
 * skips it: the pre-existing, independently-scheduled 15-minute
 * server.js#runQbEstimateSync cron already performs a full-company scan on
 * its own cadence and will catch anything this narrower, customer-scoped
 * lookup misses, so repeating that same expensive scan on every one of a
 * post-appointment job's up-to-8 retries would be a redundant, unbounded
 * source of QB API traffic — exactly what the October–November 2026
 * rate-limit reliability work (see CLAUDE.md's QB Phase 3-6 sections) was
 * built to avoid. The manual, human-triggered "Sync from QuickBooks"
 * button keeps the full scan (allowFullScan: true, the existing default)
 * since a human explicitly asking for it once is not a recurring cost.
 *
 * No new QuickBooks API call shape, matching engine, or credential path —
 * every call here is the exact same qbInternal.callQb/getLeadStatus path
 * routes/leadQB.js already used, which itself funnels through the one
 * canonical qbTokenManager.qbApiRequest (circuit-breaker protected).
 */
'use strict';

const qbEnvironment = require('./qbEnvironment');
const { query } = require('../db/client');
const qbInternal = require('./qbInternal');
const qbMatch = require('./qbMatch');

/**
 * @param {object} lead - a full `leads` row (id, first_name, last_name, email, qb_customer_id, handoff_estimate_status)
 * @param {object} [opts]
 * @param {boolean} [opts.allowFullScan=true] - whether to run the expensive full-company fallback (step 2c)
 * @returns {Promise<{success:boolean, message:string, total_fetched:number, matched:number, created:number, updated:number, qb_customer_id?:string, synced_estimate_ids:string[]}>}
 */
async function syncEstimatesForLead(lead, { allowFullScan = true } = {}) {
  // 1. Resolve the QB customer ID — use stored qb_customer_id, or look up by name/email
  let qbCustomerId = lead.qb_customer_id;
  const customerName = `${lead.first_name} ${lead.last_name}`.trim();

  if (!qbCustomerId) {
    const qbData = await qbInternal.getLeadStatus(null, customerName, lead.email);
    if (qbData.found && qbData.customer) {
      qbCustomerId = qbData.customer.Id;
      await query(
        'UPDATE leads SET qb_customer_id = $1, qb_last_sync_at = NOW(), qb_last_sync_result = $2, updated_at = NOW() WHERE id = $3',
        [qbCustomerId, 'success', lead.id]
      );
    } else {
      return {
        success: false,
        message: 'No QuickBooks customer found for this lead. Sync the lead to QB first.',
        total_fetched: 0,
        matched: 0,
        created: 0,
        updated: 0,
        synced_estimate_ids: [],
      };
    }
  }

  // 2. Fetch QB estimates for this customer (all statuses)
  const estData = await qbInternal.callQb(`/estimates/by-customer/${qbCustomerId}`, 'GET');
  let estimates = estData.estimates || [];

  // 2b. Sub-customer handling: Handoff creates project nodes as sub-customers
  //     (ParentRef.value == qbCustomerId).
  if (estimates.length === 0) {
    try {
      const allCustData = await qbInternal.callQb('/customers', 'GET');
      const allCustomers = allCustData?.customers || [];
      const subCustomerIds = allCustomers
        .filter(c => String(c.ParentRef?.value) === String(qbCustomerId))
        .map(c => String(c.Id));
      for (const subId of subCustomerIds) {
        try {
          const subEstData = await qbInternal.callQb(`/estimates/by-customer/${subId}`, 'GET');
          estimates.push(...(subEstData.estimates || []));
        } catch (e) {
          console.warn(`[lead-estimate-sync] sub-customer ${subId} fetch failed:`, e.message);
        }
      }
    } catch (e) {
      console.warn('[lead-estimate-sync] sub-customer resolution failed:', e.message);
    }
  }

  // 2c. Full-scan fallback — see header. Skipped entirely when allowFullScan
  // is false (the automated post-appointment job's default).
  if (allowFullScan) {
    let additionalFromFullScan = [];
    try {
      const allEstData = await qbInternal.callQb('/estimates', 'GET');
      const allEstimates = allEstData?.estimates || [];
      const existingIds = new Set(estimates.map(e => String(e.Id)));
      for (const est of allEstimates) {
        if (existingIds.has(String(est.Id))) continue;
        const rawRef = est.CustomerRef?.name || '';
        const billEmail = typeof est.BillEmail === 'string' ? est.BillEmail : est.BillEmail?.Address || '';
        const nameMatches = qbMatch.partialNameMatch(rawRef, lead.first_name, lead.last_name);
        const emailMatches = billEmail && qbMatch.normalizeEmail(billEmail) === qbMatch.normalizeEmail(lead.email || '');
        if (!nameMatches && !emailMatches) continue;
        const custRef = est.CustomerRef;
        if (!custRef?.value) continue;
        let customer = null;
        try {
          const custData = await qbInternal.callQb(`/customers/${custRef.value}`, 'GET');
          customer = custData?.customer;
        } catch { continue; }
        if (!customer) continue;
        const matched = qbMatch.findMatchingLead(customer, [lead]);
        if (matched) {
          additionalFromFullScan.push(est);
          existingIds.add(String(est.Id));
        }
      }
    } catch (e) {
      console.warn('[lead-estimate-sync] full-scan fallback failed:', e.message);
    }
    estimates.push(...additionalFromFullScan);
  }

  if (estimates.length === 0) {
    return {
      success: true,
      message: 'No QuickBooks estimates found for this customer.',
      total_fetched: 0,
      matched: 0,
      created: 0,
      updated: 0,
      qb_customer_id: qbCustomerId,
      synced_estimate_ids: [],
    };
  }

  // 3. Load existing QB-sourced estimates for this lead to check for duplicates
  const existingRes = await query(
    `SELECT * FROM handoff_estimates WHERE lead_id = $1 AND qb_estimate_id IS NOT NULL`,
    [lead.id]
  );
  const existing = existingRes.rows;
  const existingByQbId = new Map(existing.map(e => [String(e.qb_estimate_id), e]));

  let created = 0, updated = 0;
  const syncedEstimateIds = [];
  const qbAppUrlBase = qbEnvironment.resolveQbAppUrlBase(qbEnvironment.resolveQbEnvironment().environment);

  for (const qbEst of estimates) {
    const qbId = String(qbEst.Id);
    const qbNumber = qbEst.DocNumber || qbId;
    const totalAmt = Number(qbEst.TotalAmt) || 0;
    const status = qbEst.TxnStatus || 'Pending';
    const qbAppUrl = `${qbAppUrlBase}/app/estimate?txnId=${qbId}`;
    const estimateDate = qbEst.TxnDate || null;
    const lastSyncedAt = new Date().toISOString();

    // See lib/estimateSentDetection.js's header — zero new QB API calls,
    // qbEst already comes from this function's own fetch above.
    const qbEmailStatus = qbEst.EmailStatus || null;
    const qbEmailDeliveryTime = qbEst.DeliveryInfo?.DeliveryTime || null;

    const existingRow = existingByQbId.get(qbId);
    let handoffEstimateId;
    if (existingRow) {
      handoffEstimateId = existingRow.id;
      const pdfReset = existingRow.pdf_status === 'failed';
      await query(
        `UPDATE handoff_estimates SET
           qb_estimate_number = $1, estimate_amount = $2, estimate_status = $3,
           estimate_date = $4, qb_app_url = $5, last_synced_at = $6,
           match_status = $7, match_method = $8, sync_source = $9, source = $10,
           qb_email_status = $11, qb_email_delivery_time = $12,
           ${pdfReset ? 'pdf_status = $13, pdf_retry_count = $14,' : ''}
           updated_at = NOW()
         WHERE id = $${pdfReset ? '15' : '13'}`,
        pdfReset
          ? [qbNumber, totalAmt, status, estimateDate, qbAppUrl, lastSyncedAt,
             'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync', qbEmailStatus, qbEmailDeliveryTime, 'pending', 0, existingRow.id]
          : [qbNumber, totalAmt, status, estimateDate, qbAppUrl, lastSyncedAt,
             'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync', qbEmailStatus, qbEmailDeliveryTime, existingRow.id]
      );
      updated++;
    } else {
      const insertRes = await query(
        `INSERT INTO handoff_estimates
           (qb_estimate_id, qb_estimate_number, lead_id, customer_name,
            estimate_amount, estimate_status, estimate_date, qb_app_url,
            last_synced_at, match_status, match_method, sync_source, source,
            qb_email_status, qb_email_delivery_time,
            pdf_status, pdf_retry_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',0)
         RETURNING id`,
        [qbId, qbNumber, lead.id, qbEst.CustomerRef?.name || customerName,
         totalAmt, status, estimateDate, qbAppUrl, lastSyncedAt,
         'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync', qbEmailStatus, qbEmailDeliveryTime]
      );
      handoffEstimateId = insertRes.rows[0].id;
      created++;
      try {
        const amtStr = totalAmt > 0 ? ` — $${Number(totalAmt).toLocaleString('en-US', { minimumFractionDigits: 0 })}` : '';
        await query(
          `INSERT INTO activities (lead_id, type, content, author, source)
           VALUES ($1, 'note', $2, $3, 'manual')`,
          [lead.id, `📋 QB estimate #${qbNumber}${amtStr} synced from QuickBooks. Status: ${status}.`, 'QB Direct Sync']
        );
      } catch (e) { console.warn('[lead-estimate-sync] activity insert failed:', e.message); }
    }
    syncedEstimateIds.push(handoffEstimateId);
  }

  if (lead.handoff_estimate_status === 'awaiting_qb' && (created > 0 || updated > 0)) {
    await query(
      'UPDATE leads SET handoff_estimate_status = $1, updated_at = NOW() WHERE id = $2',
      ['synced', lead.id]
    ).catch((e) => console.warn('[lead-estimate-sync] failed to flip handoff_estimate_status for lead ' + lead.id + ':', e.message));
  }

  return {
    success: true,
    message: `Synced ${estimates.length} QuickBooks estimate(s): ${created} new, ${updated} updated`,
    total_fetched: estimates.length,
    matched: estimates.length,
    created,
    updated,
    qb_customer_id: qbCustomerId,
    synced_estimate_ids: syncedEstimateIds,
  };
}

module.exports = { syncEstimatesForLead };
