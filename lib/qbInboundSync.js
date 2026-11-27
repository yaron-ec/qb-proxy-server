/* eslint-disable no-undef */
'use strict';

/**
 * qbInboundSync — QuickBooks INBOUND synchronization engine.
 *
 * QuickBooks is the authoritative source for QB financial entities (estimates,
 * invoices, payments). This module fetches them from QB and persists to the
 * CRM database so the UI reflects QB-created transactions automatically.
 *
 * Primary matching: qb_customer_id (NOT customer name).
 * Idempotency: QB entity IDs are primary keys (ON CONFLICT DO UPDATE).
 * Duplicate prevention: re-running sync creates zero duplicates.
 *
 * Triggered by:
 *   1. Webhook (fast, event-driven) — routes/qbWebhook.js
 *   2. Scheduled reconciliation (recovery) — routes/cronJobs.js (15-minute cron in server.js)
 *   3. Manual refresh — routes/leadQB.js
 *   4. Full historical backfill — routes/qbInboundSync.js /full-backfill
 */
const { query, pool } = require('../db/client');
const { upsertInvoiceCacheFromQb, upsertMapping } = require('./qbInvoiceSaleMap');
const tokenStore = require('./qbTokenStore');
const qbTokenManager = require('./qbTokenManager');
const qbMatch = require('./qbMatch');
const { tryWithAdvisoryLock } = require('./advisoryLock');
const qbEnvironment = require('./qbEnvironment');

// Resolved once via lib/qbEnvironment.js — the SAME value server.js uses for
// its own hostname selection, so this module's credential lookup (below) and
// its API hostname can never disagree (October 2026 reliability audit —
// this module previously keyed its credential lookup off a SEPARATE
// QB_SANDBOX variable, which only coincidentally agreed with QB_ENVIRONMENT).
const QB_ENVIRONMENT = qbEnvironment.resolveQbEnvironment().environment;
const QB_API_BASE = qbEnvironment.resolveQbApiBase(QB_ENVIRONMENT);

const QB_PAGE_SIZE = 100;
// Cross-process/replica-safe re-entrancy guard (namespace 1005 — see
// lib/advisoryLock.js's registry). Was an in-process `_syncing` boolean,
// which only ever protected a single Node process — never two Railway
// replicas, or two processes, racing the same database.
const SYNC_LOCK_KEY = 'qb-inbound-reconcile';

// October 2026 production finding: syncAllMappedCustomers' loop issued at
// least 2 sequential QuickBooks API calls (Invoice query + Payment query,
// more if either is paginated) per mapped customer with ZERO pacing between
// them — fine at a handful of customers, but at ~100 mapped customers this
// bursts well over 200 rapid-sequential calls, a real contributor (alongside
// qbApiRequest's now-fixed lack of 429/5xx retry — see lib/qbTokenManager.js)
// to Intuit's rate limit being exceeded mid-run, cascading into every
// subsequent customer in that same tick also failing. This is a small,
// deliberately conservative mitigation — it does not replace the retry fix,
// it reduces how often the retry budget needs to be spent at all.
const INTER_CUSTOMER_PACING_MS = 200;

// Dependency-injection seam (mirrors lib/qbTokenManager.js's own `deps`
// pattern) so a test can assert pacing happened without a real wall-clock
// delay, and so the pacing itself is independently verifiable.
let deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pool: () => pool };
function _setDeps(d) { deps = { ...deps, ...d }; }

// ── Token management ──────────────────────────────────────────────────────────
// Delegates to lib/qbTokenManager.js — the ONE refresh implementation shared
// with server.js (single-flight + cross-process advisory lock, re-read under
// the lock, refresh-token expiry persisted). This module used to refresh on
// its own with no lock, racing server.js's refresh on the same cron minute.
// Contract unchanged: null when QuickBooks was never connected.
async function getValidTokens() {
  return qbTokenManager.getValidTokens(QB_ENVIRONMENT, { requireConnected: false });
}

// ── QB API helpers ───────────────────────────────────────────────────────────
// Through the canonical authenticated request (lib/qbTokenManager#qbApiRequest):
// auto-refreshed token, one refresh + single retry on 401, last_used_at on success.
// (`tokens` is accepted for call-site compatibility; the credential is re-read.)
async function qbQuery(q, _tokens) {
  const r = await qbTokenManager.qbApiRequest(QB_ENVIRONMENT,
    (t) => `${QB_API_BASE}/${t.realm_id}/query?query=${encodeURIComponent(q)}`, {});
  if (!r.res.ok) {
    // .status is attached (not just embedded in the message string) so a
    // caller can classify the failure (rate-limited vs. a genuine error)
    // without parsing text — see syncAllMappedCustomers's failure summary.
    // circuitOpen flags a synthetic, no-network-call skip from the shared
    // rate-limit breaker (lib/qbRateLimitBreaker.js) rather than a real
    // Intuit response — syncAllMappedCustomers uses this to stop iterating
    // the rest of the customer list immediately instead of grinding
    // through dozens more already-doomed, breaker-blocked calls.
    throw Object.assign(new Error(`QB query failed ${r.res.status}: ${(r.text || '').substring(0, 200)}`), { status: r.res.status, circuitOpen: !!r.circuitOpen });
  }
  return r.json;
}

// Paginated fetch: STARTPOSITION + MAXRESULTS until ALL entities retrieved
async function qbQueryAll(entityType, whereClause, tokens) {
  const all = [];
  let startPosition = 1;
  while (true) {
    const q = `SELECT * FROM ${entityType} WHERE ${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${QB_PAGE_SIZE}`;
    const data = await qbQuery(q, tokens);
    const items = data?.QueryResponse?.[entityType] || [];
    all.push(...items);
    if (items.length < QB_PAGE_SIZE) break;
    startPosition += QB_PAGE_SIZE;
    if (all.length >= 5000) break; // safety valve
  }
  return all;
}

// ── Auto-map invoice to sale (qb_customer_id ONLY — never customer name) ──────
async function autoMapInvoiceToSale(inv, qbCustomerId) {
  const leadRes = await query('SELECT id FROM leads WHERE qb_customer_id = $1 LIMIT 1', [String(qbCustomerId)]);
  if (!leadRes.rows.length) return { mapped: false, reason: 'no_lead_for_customer' };
  const leadId = leadRes.rows[0].id;
  const dealRes = await query('SELECT id FROM deals WHERE lead_id = $1', [leadId]);
  if (dealRes.rows.length === 0) return { mapped: false, reason: 'no_deal_for_lead' };
  if (dealRes.rows.length > 1) return { mapped: false, reason: 'ambiguous_multiple_deals' };
  const saleId = dealRes.rows[0].id;
  await upsertMapping({ query }, {
    qb_invoice_id: String(inv.Id), qb_doc_number: inv.DocNumber || null,
    crm_sale_id: saleId, crm_lead_id: leadId, qb_customer_id: String(qbCustomerId),
    mapping_method: 'backfill',
  });
  return { mapped: true, sale_id: saleId, lead_id: leadId };
}

// ── Persist payment + LinkedTxn allocations ─────────────────────────────────
async function upsertPaymentWithAllocations(payment, qbCustomerId) {
  const qbPaymentId = String(payment.Id);
  const totalAmt = Number(payment.TotalAmt) || 0;
  const unappliedAmt = Number(payment.UnappliedAmt) || 0;
  const txnDate = payment.TxnDate || null;
  const method = payment.PaymentMethodRef ? (payment.PaymentMethodRef.name || payment.PaymentMethodRef.value) : null;
  const docNumber = payment.DocNumber || null;

  await query(
    `INSERT INTO qb_payments_cache (qb_payment_id, qb_doc_number, qb_customer_id, total_amt, unapplied_amt, txn_date, method, voided, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())
     ON CONFLICT (qb_payment_id) DO UPDATE SET
       qb_doc_number = EXCLUDED.qb_doc_number, qb_customer_id = EXCLUDED.qb_customer_id,
       total_amt = EXCLUDED.total_amt, unapplied_amt = EXCLUDED.unapplied_amt,
       txn_date = EXCLUDED.txn_date, method = EXCLUDED.method, voided = FALSE, last_synced_at = NOW()`,
    [qbPaymentId, docNumber, String(qbCustomerId), totalAmt, unappliedAmt, txnDate, method]
  );

  // Replace allocations (DELETE + INSERT) — idempotent mirror of QB LinkedTxn
  await query('DELETE FROM qb_payment_allocations WHERE qb_payment_id = $1', [qbPaymentId]);

  let allocCount = 0;
  const lines = payment.Line || [];
  for (const line of lines) {
    const linked = line.LinkedTxn || [];
    for (const txn of linked) {
      if (txn.TxnType === 'Invoice' && txn.TxnId) {
        const allocationAmt = Number(line.Amount) || 0;
        await query(
          `INSERT INTO qb_payment_allocations (qb_payment_id, qb_invoice_id, allocation_amt, last_synced_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (qb_payment_id, qb_invoice_id) DO UPDATE SET
             allocation_amt = EXCLUDED.allocation_amt, last_synced_at = NOW()`,
          [qbPaymentId, String(txn.TxnId), allocationAmt]
        );
        allocCount++;
      }
    }
  }
  return allocCount;
}

// ── Mark a single invoice/payment voided by id (CDC "Deleted" status) ───────
// Distinct from markStaleAsVoided below (a per-customer DIFF against a full
// fetch) — this is the targeted, single-record equivalent the incremental
// CDC path uses, since it only ever sees the one record QuickBooks reported
// changed/deleted, never a full per-customer list to diff against.
async function markInvoiceVoidedById(qbInvoiceId) {
  await query('UPDATE qb_invoices_cache SET voided = TRUE, last_synced_at = NOW() WHERE qb_invoice_id = $1', [String(qbInvoiceId)]);
}
async function markPaymentVoidedById(qbPaymentId) {
  await query('UPDATE qb_payments_cache SET voided = TRUE, last_synced_at = NOW() WHERE qb_payment_id = $1', [String(qbPaymentId)]);
}

// ── Mark cached entities not in QB response as voided (deleted in QB) ─────────
async function markStaleAsVoided(qbCustomerId, foundInvoiceIds, foundPaymentIds) {
  // Mark invoices that are in the cache for this customer but NOT in QB response
  if (foundInvoiceIds.length > 0) {
    const placeholders = foundInvoiceIds.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE qb_invoices_cache SET voided = TRUE WHERE qb_customer_id = $1 AND qb_invoice_id NOT IN (${placeholders})`,
      [String(qbCustomerId), ...foundInvoiceIds]
    );
  } else {
    await query('UPDATE qb_invoices_cache SET voided = TRUE WHERE qb_customer_id = $1', [String(qbCustomerId)]);
  }
  // Mark payments not in QB response as voided
  if (foundPaymentIds.length > 0) {
    const placeholders = foundPaymentIds.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE qb_payments_cache SET voided = TRUE WHERE qb_customer_id = $1 AND qb_payment_id NOT IN (${placeholders})`,
      [String(qbCustomerId), ...foundPaymentIds]
    );
  } else {
    await query('UPDATE qb_payments_cache SET voided = TRUE WHERE qb_customer_id = $1', [String(qbCustomerId)]);
  }
}

// ── Core: sync a single customer's financials (paginated) ────────────────────
async function syncCustomerFinancials(qbCustomerId) {
  if (!qbCustomerId) throw new Error('qbCustomerId is required');
  const tokens = await getValidTokens();
  if (!tokens) return { synced: false, reason: 'no_qb_tokens' };
  const result = { qb_customer_id: String(qbCustomerId), invoices: 0, payments: 0, mapped: 0, allocations: 0, errors: [] };
  try {
    // 1. Fetch ALL invoices (paginated) and persist
    const invoices = await qbQueryAll('Invoice', `CustomerRef = '${String(qbCustomerId)}'`, tokens);
    result.invoices = invoices.length;
    const foundInvoiceIds = [];
    for (const inv of invoices) {
      try {
        await upsertInvoiceCacheFromQb({ query }, inv);
        foundInvoiceIds.push(String(inv.Id));
        const mapResult = await autoMapInvoiceToSale(inv, qbCustomerId);
        if (mapResult.mapped) result.mapped++;
      } catch (e) { result.errors.push({ invoice_id: inv.Id, error: e.message }); }
    }

    // 2. Fetch ALL payments (paginated) and persist with allocations
    const payments = await qbQueryAll('Payment', `CustomerRef = '${String(qbCustomerId)}'`, tokens);
    result.payments = payments.length;
    const foundPaymentIds = [];
    for (const payment of payments) {
      try {
        const allocCount = await upsertPaymentWithAllocations(payment, qbCustomerId);
        foundPaymentIds.push(String(payment.Id));
        result.allocations += allocCount;
      } catch (e) { result.errors.push({ payment_id: payment.Id, error: e.message }); }
    }

    // 3. Mark stale cached entities (deleted in QB) as voided
    await markStaleAsVoided(qbCustomerId, foundInvoiceIds, foundPaymentIds);

    // 4. Update lead sync timestamp
    await query('UPDATE leads SET qb_last_sync_at = NOW(), qb_last_sync_result = $1, updated_at = NOW() WHERE qb_customer_id = $2',
      ['success', String(qbCustomerId)]);
    if (tokens.realm_id) { try { await tokenStore.markUsed(QB_ENVIRONMENT, tokens.realm_id); } catch {} }
    result.synced = true;
    return result;
  } catch (e) {
    // .status (attached by qbQuery above) lets the caller classify this as
    // rate-limited/transient vs. a genuine failure without parsing e.message.
    result.synced = false; result.error = e.message; result.error_status = e.status || null; result.circuit_open = !!e.circuitOpen;
    try { await query('UPDATE leads SET qb_last_sync_at = NOW(), qb_last_sync_result = $1, qb_last_error = $2, updated_at = NOW() WHERE qb_customer_id = $3',
      ['error', e.message.substring(0, 500), String(qbCustomerId)]); } catch {}
    return result;
  }
}

// Sanitized failure breakdown — HTTP status counts only, never the raw
// message (which can contain QuickBooks response body fragments), never any
// customer/financial identifier. Safe to log directly.
function summarizeFailures(results) {
  const summary = {};
  for (const r of results) {
    if (r.synced) continue;
    const key = r.error_status ? `status_${r.error_status}` : 'other';
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

// ── Incremental, company-wide sync via QuickBooks Change Data Capture ──────
//
// November 2026 "QB API consumption root-cause investigation": official
// Intuit Developer Portal data (500,766 CorePlus calls/30 days —
// query/invoice 201,180, query/payment 201,175, Customer 98,285, 80%+ of
// ALL calls) confirmed syncAllMappedCustomers above as the dominant cost —
// its own per-customer, non-incremental `WHERE CustomerRef = 'X'` queries
// re-fetch EVERY invoice/payment for EVERY mapped customer on EVERY tick,
// regardless of whether anything actually changed, 2 calls x however many
// mapped customers (104 observed), every single run. Replacing the loop's
// SHAPE (not its correctness) is the fix: one company-wide, timestamp-
// cursored Change Data Capture call covers every mapped customer's changes
// in 1-2 requests total, instead of 2 requests PER customer.
//
// CDC's own documented limits (researched, not assumed — see CLAUDE.md's
// "QuickBooks API quota management" section for the full citation):
//   - 30-day lookback cap — a cursor older than that cannot be bridged by
//     CDC at all; CDC_LOOKBACK_SAFETY_DAYS keeps a 1-day margin under the
//     real cap before falling back.
//   - Reports a `status: 'Deleted'` entry for a removed entity — closing
//     the one correctness gap a plain incremental query would have (a hard
//     delete never bumps MetaData.LastUpdatedTime on a record that no
//     longer exists, so an ordinary "WHERE LastUpdatedTime > cursor" query
//     could never surface it; CDC's own Deleted-status stub can).
//
// Financial accuracy is NOT traded for this efficiency: every real
// Invoice/Payment this call returns is upserted through the EXACT SAME
// upsertInvoiceCacheFromQb / upsertPaymentWithAllocations / autoMapInvoiceToSale
// functions syncAllMappedCustomers already used (reused verbatim, never
// re-implemented) — idempotent by construction (ON CONFLICT DO UPDATE), so
// re-processing an already-seen record (the deliberate overlap buffer
// below) is always harmless. syncAllMappedCustomers itself is UNCHANGED and
// kept running as a once-daily safety net (see server.js's new full-
// reconcile cron) — this never replaces full reconciliation, only reduces
// how often the EXPENSIVE shape of it needs to run, per the explicit
// instruction not to blindly drop full reconciliation's own completeness
// guarantee.
const CDC_LOOKBACK_CAP_DAYS = 30;
const CDC_LOOKBACK_SAFETY_DAYS = CDC_LOOKBACK_CAP_DAYS - 1;
const CDC_OVERLAP_BUFFER_MS = 5 * 60 * 1000; // 5-minute re-processing overlap — never a missed boundary record
const INCREMENTAL_CURSOR_KEY = 'quickbooks_inbound_reconcile'; // SAME key the prior hourly full-reconcile cron used — keeps lib/monitoring/healthProbes.js#checkQbSyncScheduler's existing staleness check correct with zero changes there.

// November 2026 final-acceptance follow-up: Intuit's own CDC documentation
// confirms a single response is capped at 1000 objects TOTAL, with no
// pagination support for this endpoint at all (unlike a plain query, which
// paginates via STARTPOSITION/MAXRESULTS) — the documented workaround is to
// narrow the changedSince window. A high-volume change period (a long
// outage's accumulated backlog, or simply a busy day) could silently
// truncate a CDC response with NO error returned — we would never know
// records were cut off. Financial accuracy outranks API savings here: when
// either entity's returned count reaches this threshold, the response is
// treated as POSSIBLY TRUNCATED and this tick falls back to the full
// per-customer reconciliation instead of trusting a response that might be
// missing records — full reconciliation is never truncated the same way
// (each customer's own invoice/payment query is separately paginated via
// qbQueryAll's own STARTPOSITION/MAXRESULTS loop).
const CDC_TRUNCATION_SUSPECTED_THRESHOLD = 1000;
const { classifySyncOutcome, isSuccessfulOutcome } = require('./syncOutcome');

async function fetchCdcChanges(entities, changedSinceIso) {
  const entityParam = entities.join(',');
  const r = await qbTokenManager.qbApiRequest(QB_ENVIRONMENT,
    (t) => `${QB_API_BASE}/${t.realm_id}/cdc?entities=${encodeURIComponent(entityParam)}&changedSince=${encodeURIComponent(changedSinceIso)}&minorversion=65`, {});
  if (!r.res.ok) {
    throw Object.assign(new Error(`QB CDC failed ${r.res.status}: ${(r.text || '').substring(0, 200)}`), { status: r.res.status, circuitOpen: !!r.circuitOpen });
  }
  const blocks = r.json?.CDCResponse || [];
  const out = {};
  for (const e of entities) out[e] = [];
  for (const block of blocks) {
    for (const qr of (block.QueryResponse || [])) {
      for (const e of entities) {
        if (Array.isArray(qr[e])) out[e].push(...qr[e]);
      }
    }
  }
  return out;
}

async function getCursorRow(integration) {
  const res = await query('SELECT last_cursor, last_updated_timestamp FROM sync_cursors WHERE integration = $1', [integration]);
  return res.rows[0] || null;
}

// Advances the watermark AND marks this tick as a genuine success —
// use ONLY when the tick was clean (classifySyncOutcome says so). This is
// specifically what lib/qbRecoveryVerification.js reads to decide whether
// a "QuickBooks recovered" notification may fire — advancing it on a
// partial/failed tick would let that notification fire on a sync that
// never actually finished the job.
async function setCursorRow(integration, isoWatermark, summary) {
  await query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp, last_successful_sync_at, last_attempted_at, last_sync_summary)
     VALUES ($1, $2::text, $2::timestamptz, NOW(), NOW(), $3::jsonb)
     ON CONFLICT (integration) DO UPDATE SET
       last_cursor = EXCLUDED.last_cursor, last_updated_timestamp = EXCLUDED.last_updated_timestamp,
       last_successful_sync_at = NOW(), last_attempted_at = NOW(), last_sync_summary = EXCLUDED.last_sync_summary, updated_at = NOW()`,
    [integration, isoWatermark, JSON.stringify(summary || {})]
  );
}

// Advances the watermark (forward progress is still safe — every upsert
// this module performs is idempotent, so re-processing a window on retry
// never duplicates anything) but deliberately does NOT touch
// last_successful_sync_at — a tick with item-level errors is real forward
// progress, but it is never reported as a "genuine successful
// synchronization" to lib/qbRecoveryVerification.js or System Health.
async function advanceWatermarkOnly(integration, isoWatermark, summary) {
  await query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp, last_attempted_at, last_sync_summary)
     VALUES ($1, $2::text, $2::timestamptz, NOW(), $3::jsonb)
     ON CONFLICT (integration) DO UPDATE SET
       last_cursor = EXCLUDED.last_cursor, last_updated_timestamp = EXCLUDED.last_updated_timestamp,
       last_attempted_at = NOW(), last_sync_summary = EXCLUDED.last_sync_summary, updated_at = NOW()`,
    [integration, isoWatermark, JSON.stringify(summary || {})]
  );
}

async function markAttemptOnly(integration, summary) {
  await query(
    `INSERT INTO sync_cursors (integration, last_attempted_at, last_sync_summary)
     VALUES ($1, NOW(), $2::jsonb)
     ON CONFLICT (integration) DO UPDATE SET last_attempted_at = NOW(), last_sync_summary = EXCLUDED.last_sync_summary, updated_at = NOW()`,
    [integration, JSON.stringify(summary || {})]
  );
}

// Shared fallback runner — used both for a missing/stale CDC cursor and for
// a suspected-truncated CDC response. Only a genuinely CLEAN full-sync
// outcome ('success'/'no_work') advances the watermark to "now": that is
// the one case where we have actually just re-fetched EVERY mapped
// customer's current data, so starting CDC fresh from this moment is safe.
// A partial/blocked/failed fallback must NEVER advance the watermark — some
// customers' data was never (re)fetched this attempt, and jumping the
// cursor to "now" would silently and permanently skip their changes from
// every future CDC call. last_attempted_at still records that we tried, so
// System Health can tell "never attempted" apart from "attempted but not
// yet clean".
async function runFullReconcileFallback(reason) {
  console.warn(`[qb-inbound-sync] ${reason} — falling back to full per-customer reconciliation to re-establish a baseline`);
  const fullResult = await syncAllMappedCustomers();
  const outcome = classifySyncOutcome({
    attempted: fullResult.total || 0,
    succeeded: fullResult.synced || 0,
    failed: fullResult.failed || 0,
    stoppedEarly: !!fullResult.stopped_early,
  });
  if (!fullResult.skipped) {
    const summary = { mode: 'cdc_fallback_full', fallback_reason: reason, outcome, ...fullResult };
    if (isSuccessfulOutcome(outcome)) {
      await setCursorRow(INCREMENTAL_CURSOR_KEY, new Date().toISOString(), summary);
    } else {
      await markAttemptOnly(INCREMENTAL_CURSOR_KEY, summary);
    }
  }
  return { ok: true, mode: 'cdc_fallback_full', outcome, ...fullResult };
}

async function syncInvoicesPaymentsIncremental() {
  const lockResult = await tryWithAdvisoryLock(deps.pool(), 1005, 'qb-cdc-incremental', async () => {
    const tokens = await getValidTokens();
    if (!tokens) {
      await markAttemptOnly(INCREMENTAL_CURSOR_KEY, { mode: 'cdc', reason: 'no_qb_tokens' });
      return { ok: false, mode: 'cdc', reason: 'no_qb_tokens' };
    }

    const cursorRow = await getCursorRow(INCREMENTAL_CURSOR_KEY);
    const lastWatermark = cursorRow?.last_updated_timestamp ? new Date(cursorRow.last_updated_timestamp) : null;
    const ageMs = lastWatermark ? (Date.now() - lastWatermark.getTime()) : Infinity;
    const capMs = CDC_LOOKBACK_SAFETY_DAYS * 24 * 60 * 60 * 1000;

    if (!lastWatermark || ageMs > capMs) {
      // No cursor yet, or the gap exceeds CDC's documented 30-day lookback —
      // CDC cannot bridge this gap at all. Self-heal via the shared fallback.
      // No operator action needed.
      return runFullReconcileFallback(lastWatermark ? `CDC cursor older than ${CDC_LOOKBACK_SAFETY_DAYS} days` : 'CDC cursor missing');
    }

    // Deliberate overlap: re-request from slightly BEFORE the last watermark
    // so a record updated in the same instant as a previous run's cutoff is
    // never silently skipped. Re-processing it is harmless (idempotent
    // upserts below).
    const changedSince = new Date(lastWatermark.getTime() - CDC_OVERLAP_BUFFER_MS).toISOString();

    let changes;
    try {
      changes = await fetchCdcChanges(['Invoice', 'Payment'], changedSince);
    } catch (e) {
      await markAttemptOnly(INCREMENTAL_CURSOR_KEY, { mode: 'cdc', error: e.message, error_status: e.status || null, circuit_open: !!e.circuitOpen });
      return { ok: false, mode: 'cdc', error: e.message, circuit_open: !!e.circuitOpen };
    }

    if (changes.Invoice.length >= CDC_TRUNCATION_SUSPECTED_THRESHOLD || changes.Payment.length >= CDC_TRUNCATION_SUSPECTED_THRESHOLD) {
      return runFullReconcileFallback(
        `CDC response hit the suspected truncation threshold (Invoice=${changes.Invoice.length}, Payment=${changes.Payment.length}, threshold=${CDC_TRUNCATION_SUSPECTED_THRESHOLD})`
      );
    }

    let invoicesUpserted = 0, invoicesDeleted = 0, paymentsUpserted = 0, paymentsDeleted = 0, mapped = 0, allocations = 0;
    const errors = [];
    let maxSeenMs = lastWatermark.getTime();

    for (const inv of changes.Invoice) {
      try {
        if (inv.status === 'Deleted') { await markInvoiceVoidedById(inv.Id); invoicesDeleted++; }
        else {
          await upsertInvoiceCacheFromQb({ query }, inv);
          const customerId = inv.CustomerRef?.value;
          if (customerId) { const m = await autoMapInvoiceToSale(inv, customerId); if (m.mapped) mapped++; }
          invoicesUpserted++;
        }
        const ts = inv.MetaData?.LastUpdatedTime ? new Date(inv.MetaData.LastUpdatedTime).getTime() : null;
        if (ts && ts > maxSeenMs) maxSeenMs = ts;
      } catch (e) { errors.push({ type: 'invoice', id: inv.Id, error: e.message }); }
    }
    for (const pay of changes.Payment) {
      try {
        if (pay.status === 'Deleted') { await markPaymentVoidedById(pay.Id); paymentsDeleted++; }
        else {
          const customerId = pay.CustomerRef?.value;
          allocations += await upsertPaymentWithAllocations(pay, customerId);
          paymentsUpserted++;
        }
        const ts = pay.MetaData?.LastUpdatedTime ? new Date(pay.MetaData.LastUpdatedTime).getTime() : null;
        if (ts && ts > maxSeenMs) maxSeenMs = ts;
      } catch (e) { errors.push({ type: 'payment', id: pay.Id, error: e.message }); }
    }

    const attempted = invoicesUpserted + invoicesDeleted + paymentsUpserted + paymentsDeleted + errors.length;
    const outcome = classifySyncOutcome({ attempted, succeeded: attempted - errors.length, failed: errors.length, stoppedEarly: false });
    const summary = {
      mode: 'cdc', changed_since: changedSince, outcome,
      invoices_upserted: invoicesUpserted, invoices_deleted: invoicesDeleted,
      payments_upserted: paymentsUpserted, payments_deleted: paymentsDeleted,
      mapped, allocations, errors: errors.slice(0, 20),
    };
    // The watermark always advances on a completed CDC fetch (safe — every
    // write above is idempotent, so a future retry of this same window can
    // never duplicate anything), but last_successful_sync_at only advances
    // on a CLEAN tick (zero item-level errors) — see advanceWatermarkOnly's
    // own header for why a partial tick must never look like a genuine
    // successful synchronization.
    if (isSuccessfulOutcome(outcome)) {
      await setCursorRow(INCREMENTAL_CURSOR_KEY, new Date(maxSeenMs).toISOString(), summary);
    } else {
      await advanceWatermarkOnly(INCREMENTAL_CURSOR_KEY, new Date(maxSeenMs).toISOString(), summary);
    }
    return { ok: true, ...summary };
  });
  if (lockResult.skipped) return { skipped: true, reason: 'already_in_progress' };
  return lockResult.result;
}

// ── Sync ALL mapped customers (scheduled reconciliation) ─────────────────────
async function syncAllMappedCustomers() {
  const lockResult = await tryWithAdvisoryLock(deps.pool(), 1005, SYNC_LOCK_KEY, async () => {
    const res = await query('SELECT DISTINCT qb_customer_id FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != \'\'');
    const customerIds = res.rows.map(r => r.qb_customer_id);
    const results = []; let synced = 0, failed = 0, stoppedEarly = false;
    for (let i = 0; i < customerIds.length; i++) {
      const customerId = customerIds[i];
      try {
        const r = await syncCustomerFinancials(customerId);
        results.push(r); if (r.synced) synced++; else failed++;
        if (r.circuit_open) {
          // The shared rate-limit breaker (lib/qbRateLimitBreaker.js) has
          // opened — every remaining customer would also be a synthetic,
          // no-network skip. Stop the tick here instead of grinding
          // through the rest; the next tick (or the breaker's own
          // half-open trial) picks up where this left off.
          console.warn(`[qb-inbound-sync] circuit breaker OPEN — stopping early at customer ${i + 1}/${customerIds.length}`);
          stoppedEarly = true;
          break;
        }
      } catch (e) {
        results.push({ qb_customer_id: customerId, synced: false, error: e.message, error_status: e.status || null, circuit_open: !!e.circuitOpen });
        failed++;
        if (e.circuitOpen) {
          console.warn(`[qb-inbound-sync] circuit breaker OPEN — stopping early at customer ${i + 1}/${customerIds.length}`);
          stoppedEarly = true;
          break;
        }
      }
      if (i < customerIds.length - 1) await deps.sleep(INTER_CUSTOMER_PACING_MS);
    }
    return { total: customerIds.length, synced, failed, stopped_early: stoppedEarly, failureSummary: summarizeFailures(results), results };
  });
  if (lockResult.skipped) return { skipped: true, reason: 'already_in_progress' };
  return lockResult.result;
}

// ── Discovery: link unmapped CRM leads to existing QB customers ──────────────
// Conservative matching: requires email OR phone match + name match.
// NEVER guesses. Multiple matches → unresolved.
async function discoverAndLinkUnmappedCustomers() {
  const tokens = await getValidTokens();
  if (!tokens) return { discovered: false, reason: 'no_qb_tokens' };

  // 1. Fetch ALL QB customers (paginated)
  const qbCustomers = await qbQueryAll('Customer', 'Active = true', tokens);

  // 2. Fetch ALL unmapped CRM leads (no qb_customer_id)
  const leadRes = await query(
    'SELECT id, first_name, last_name, email, phone FROM leads WHERE (qb_customer_id IS NULL OR qb_customer_id = \'\') AND first_name IS NOT NULL AND last_name IS NOT NULL'
  );
  const unmappedLeads = leadRes.rows;

  let linked = 0, unresolved = 0, noMatch = 0;
  const unresolvedDetails = [];

  for (const lead of unmappedLeads) {
    const leadEmail = qbMatch.normalizeEmail(lead.email || '');
    const leadPhone = qbMatch.normalizePhone(lead.phone || '');

    // Skip leads with no email AND no phone — can't safely match
    if (!leadEmail && !leadPhone) { noMatch++; continue; }

    const candidates = [];
    for (const cust of qbCustomers) {
      const custEmail = qbMatch.normalizeEmail(cust.PrimaryEmailAddr ? cust.PrimaryEmailAddr.Address : '');
      const custPhone = qbMatch.normalizePhone(cust.PrimaryPhone ? cust.PrimaryPhone.FreeFormNumber : '');
      const custName = cust.DisplayName || '';
      const custId = String(cust.Id);

      let score = 0;
      const matchedOn = [];

      // Email match: strong signal
      if (leadEmail && custEmail && leadEmail === custEmail) { score += 100; matchedOn.push('email'); }
      // Phone match: strong signal
      if (leadPhone && custPhone && leadPhone === custPhone) { score += 80; matchedOn.push('phone'); }
      // Name match: confirming signal (only counts if email or phone also matched)
      if (score > 0 && custName && qbMatch.partialNameMatch(custName, lead.first_name, lead.last_name)) {
        score += 20; matchedOn.push('name');
      }

      // Require at least email or phone match (score >= 80)
      if (score >= 80) {
        candidates.push({ qb_customer_id: custId, score, matchedOn });
      }
    }

    if (candidates.length === 1) {
      // Unambiguous match → persist qb_customer_id
      const match = candidates[0];
      await query(
        'UPDATE leads SET qb_customer_id = $1, qb_last_sync_at = NOW(), qb_last_sync_result = $2, updated_at = NOW() WHERE id = $3',
        [match.qb_customer_id, 'auto_linked', lead.id]
      );
      linked++;
    } else if (candidates.length > 1) {
      // Ambiguous → unresolved
      unresolved++;
      unresolvedDetails.push({ lead_id: lead.id, lead_name: `${lead.first_name} ${lead.last_name}`, candidates: candidates.length });
    } else {
      noMatch++;
    }
  }

  return {
    discovered: true,
    qb_customers_inspected: qbCustomers.length,
    unmapped_leads: unmappedLeads.length,
    linked, unresolved, no_match: noMatch,
    unresolved_details: unresolvedDetails.slice(0, 50), // cap for response size
  };
}

// ── Full historical backfill ─────────────────────────────────────────────────
// Orchestrates: discovery → sync all mapped customers → comprehensive report
async function runFullHistoricalBackfill() {
  const report = {
    phase1_discovery: null,
    phase2_sync: null,
    summary: {},
  };

  // Phase 1: Discovery — link unmapped CRM leads to existing QB customers
  try {
    report.phase1_discovery = await discoverAndLinkUnmappedCustomers();
  } catch (e) {
    report.phase1_discovery = { discovered: false, error: e.message };
  }

  // Phase 2: Sync ALL mapped customers (including newly linked ones)
  try {
    report.phase2_sync = await syncAllMappedCustomers();
  } catch (e) {
    report.phase2_sync = { error: e.message };
  }

  // Build summary
  const disc = report.phase1_discovery || {};
  const sync = report.phase2_sync || {};
  report.summary = {
    qb_customers_inspected: disc.qb_customers_inspected || 0,
    crm_leads_already_mapped: (sync.total || 0) - (disc.linked || 0),
    crm_leads_newly_linked: disc.linked || 0,
    unresolved_customer_matches: disc.unresolved || 0,
    total_invoices_fetched: (sync.results || []).reduce((s, r) => s + (r.invoices || 0), 0),
    total_payments_fetched: (sync.results || []).reduce((s, r) => s + (r.payments || 0), 0),
    total_allocations: (sync.results || []).reduce((s, r) => s + (r.allocations || 0), 0),
    total_invoice_deal_mappings: (sync.results || []).reduce((s, r) => s + (r.mapped || 0), 0),
    total_failed_customers: sync.failed || 0,
    total_synced_customers: sync.synced || 0,
  };

  return report;
}

module.exports = {
  syncCustomerFinancials, syncAllMappedCustomers,
  syncInvoicesPaymentsIncremental,
  discoverAndLinkUnmappedCustomers, runFullHistoricalBackfill,
  getValidTokens,
  qbQuery,
  fetchCdcChanges,
  CDC_LOOKBACK_CAP_DAYS, CDC_LOOKBACK_SAFETY_DAYS, INCREMENTAL_CURSOR_KEY,
  _setDeps,
};
