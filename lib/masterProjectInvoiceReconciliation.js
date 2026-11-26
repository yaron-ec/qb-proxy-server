/* eslint-disable no-undef */
'use strict';

/**
 * masterProjectInvoiceReconciliation — itemized, invoice-level, read-only
 * reconciliation for a Master Project (a root deal + its addendums),
 * built for the November 2026 Ali & Mohemmed Lalani "$42,031 vs
 * management-confirmed $40,934" investigation (see CLAUDE.md's "Master
 * Project 'Collected' double-counting fix..." section for the fix this
 * builds on top of).
 *
 * PURELY READ-ONLY — every query in this module is a SELECT. It never
 * writes, voids, reassigns, or fabricates anything. It exists to answer,
 * for any Master Project, exactly which cached QuickBooks invoice records
 * currently produce the CRM's own `invoiced`/`collected` totals, so a
 * discrepancy against a management-confirmed real-world figure can be
 * investigated with real evidence instead of a guess.
 *
 * For every QuickBooks invoice cached for this customer (via
 * qb_invoices_cache, keyed by qb_customer_id — NOT filtered to only the
 * invoices already mapped to one of this Master Project's deals, since
 * `lib/customerPaymentWaterfall.js#getCustomerTotalReceived` sums by
 * qb_customer_id regardless of mapping, and an unmapped invoice can still
 * influence a sibling addendum's waterfall-fallback allocation), this
 * reports:
 *   - every field requested for the itemized reconciliation (invoice
 *     number, QB transaction id, invoice date, original amount, paid
 *     amount, outstanding balance, cached status, voided flag, last sync
 *     timestamp);
 *   - which deal (if any) in THIS Master Project it is mapped to, or
 *     whether it is mapped to a DIFFERENT, unrelated deal, or not mapped
 *     to any CRM deal at all;
 *   - whether it is currently counted in the Master Project's `invoiced`/
 *     `collected` figures (mirrors `lib/qbInvoiceSaleMap.js#getInvoicesForSale`'s
 *     own filter EXACTLY — mapped to one of this project's own deal ids,
 *     AND the mapping row's own `voided` flag is false, AND the cached
 *     invoice row's own `voided` flag is false);
 *   - a duplicate-document-number flag (a strong, non-guessed signal of a
 *     double-synced or re-created QuickBooks invoice for the same real
 *     transaction).
 *
 * The summary section computes, from the real rows returned, the exact
 * `computed_collected_total` this Master Project's aggregation would
 * currently produce (the same figure `lib/dealFinancialAggregation.js`
 * computes), the raw `customer_total_received_all_cached_invoices` (every
 * cached invoice for this customer, mapped or not, voided or not excluded
 * the same way the waterfall itself excludes voided rows), and reports the
 * gap between them explicitly — never guessing which invoice "is" a
 * discrepancy; a human reviews the itemized list.
 */
const { round2 } = require('./qbInvoiceSaleMap');

/**
 * Resolves the root deal + all of its addendums, exactly mirroring
 * routes/deals.js's GET /:id/addendums resolution (addendums are one
 * level deep only).
 */
async function resolveMasterProjectDeals(db, dealIdOrRef) {
  const { rows } = await db.query(
    `SELECT * FROM deals WHERE id = $1::uuid OR legacy_base44_id = $2 LIMIT 1`,
    [/^[0-9a-f-]{36}$/i.test(String(dealIdOrRef)) ? dealIdOrRef : '00000000-0000-0000-0000-000000000000', String(dealIdOrRef)]
  );
  const deal = rows[0];
  if (!deal) return { deal: null, rootDeal: null, addendumDeals: [] };

  let rootDeal = deal;
  if (deal.parent_deal_id) {
    const parentRes = await db.query('SELECT * FROM deals WHERE id = $1', [deal.parent_deal_id]);
    if (parentRes.rows[0]) rootDeal = parentRes.rows[0];
  }
  const { rows: addendumDeals } = await db.query(
    `SELECT * FROM deals WHERE parent_deal_id = $1 ORDER BY created_at ASC`,
    [rootDeal.id]
  );
  return { deal, rootDeal, addendumDeals };
}

/**
 * The full itemized reconciliation for a Master Project, identified by
 * any deal id/legacy ref within it (root or addendum — same resolution
 * rule as the existing GET /:id/addendums route).
 */
async function getMasterProjectInvoiceReconciliation(db, dealIdOrRef) {
  const { deal, rootDeal, addendumDeals } = await resolveMasterProjectDeals(db, dealIdOrRef);
  if (!deal) return { found: false };

  const masterDeals = [rootDeal, ...addendumDeals];
  const masterDealIds = new Set(masterDeals.map((d) => d.id));

  const lead = rootDeal.lead_id
    ? (await db.query('SELECT id, first_name, last_name, qb_customer_id FROM leads WHERE id = $1', [rootDeal.lead_id])).rows[0]
    : null;
  const qbCustomerId = lead?.qb_customer_id || null;

  if (!qbCustomerId) {
    return {
      found: true,
      root_deal: { id: rootDeal.id, name: rootDeal.name, amount: Number(rootDeal.amount) || 0 },
      addendum_deals: addendumDeals.map((d) => ({ id: d.id, name: d.name, amount: Number(d.amount) || 0 })),
      qb_customer_id: null,
      note: 'This lead has no qb_customer_id — there is no QuickBooks customer to reconcile invoices against.',
      invoices: [],
      summary: null,
    };
  }

  // Every cached QuickBooks invoice for this customer, mapped or not,
  // voided or not — a complete picture, never pre-filtered the way the
  // live app's own getInvoicesForSale() is (that filter is reproduced
  // explicitly, per row, below, instead of applied at the SQL level, so a
  // voided or unmapped row that is EXCLUDED from the live totals is still
  // visible here for investigation).
  const { rows: invoiceRows } = await db.query(
    `SELECT
       c.qb_invoice_id, c.qb_doc_number, c.total_amt, c.balance, c.paid,
       c.txn_status, c.voided AS cache_voided, c.txn_date, c.last_synced_at,
       m.crm_sale_id, m.crm_lead_id, m.mapping_method, m.voided AS map_voided
     FROM qb_invoices_cache c
     LEFT JOIN qb_invoice_sale_map m ON m.qb_invoice_id = c.qb_invoice_id
     WHERE c.qb_customer_id = $1
     ORDER BY c.txn_date NULLS LAST, c.qb_invoice_id`,
    [String(qbCustomerId)]
  );

  const dealNameById = new Map(masterDeals.map((d) => [d.id, d.name]));
  // A deal OUTSIDE this Master Project that a stray invoice might be
  // mapped to — resolved by name only for display, never used to decide
  // inclusion (inclusion is decided purely by masterDealIds membership).
  const otherDealIds = new Set(
    invoiceRows.map((r) => r.crm_sale_id).filter((id) => id && !masterDealIds.has(id))
  );
  let otherDealNameById = new Map();
  if (otherDealIds.size > 0) {
    const { rows: otherDeals } = await db.query(
      `SELECT id, name FROM deals WHERE id = ANY($1::uuid[])`,
      [[...otherDealIds]]
    );
    otherDealNameById = new Map(otherDeals.map((d) => [d.id, d.name]));
  }

  // Duplicate-document-number detection — same real-world transaction
  // possibly synced twice under two different qb_invoice_id values.
  const byDocNumber = new Map();
  for (const r of invoiceRows) {
    if (!r.qb_doc_number) continue;
    if (!byDocNumber.has(r.qb_doc_number)) byDocNumber.set(r.qb_doc_number, []);
    byDocNumber.get(r.qb_doc_number).push(r.qb_invoice_id);
  }
  const duplicateDocNumbers = new Set(
    [...byDocNumber.entries()].filter(([, ids]) => ids.length > 1).map(([doc]) => doc)
  );

  let computedInvoicedTotal = 0;
  let computedCollectedTotal = 0;
  let customerTotalReceivedAllCachedInvoices = 0;

  const invoices = invoiceRows.map((r) => {
    const totalAmt = round2(Number(r.total_amt) || 0);
    const paid = round2(Number(r.paid) || 0);
    const balance = round2(Number(r.balance) || 0);
    const cacheVoided = !!r.cache_voided;
    const mapVoided = !!r.map_voided;

    // Mirrors lib/customerPaymentWaterfall.js#getCustomerTotalReceived
    // EXACTLY: sum of qb_invoices_cache.paid for this customer, excluding
    // only the CACHE row's own voided flag (the map's voided flag is
    // irrelevant to that function — it never joins qb_invoice_sale_map at
    // all).
    if (!cacheVoided) customerTotalReceivedAllCachedInvoices = round2(customerTotalReceivedAllCachedInvoices + paid);

    const mappedToMasterProjectDeal = r.crm_sale_id && masterDealIds.has(r.crm_sale_id);
    // Mirrors lib/qbInvoiceSaleMap.js#getInvoicesForSale's EXACT WHERE
    // clause: mapped to crm_sale_id AND m.voided=false AND c.voided=false.
    const includedInCollected = mappedToMasterProjectDeal && !mapVoided && !cacheVoided;

    let associatedProject = 'Not mapped to any CRM deal';
    if (r.crm_sale_id) {
      if (mappedToMasterProjectDeal) {
        associatedProject = `${dealNameById.get(r.crm_sale_id)} (${r.crm_sale_id === rootDeal.id ? 'root' : 'addendum'})`;
      } else {
        associatedProject = `A DIFFERENT, unrelated deal: ${otherDealNameById.get(r.crm_sale_id) || '(unknown)'} (${r.crm_sale_id})`;
      }
    }

    if (includedInCollected) {
      computedInvoicedTotal = round2(computedInvoicedTotal + totalAmt);
      computedCollectedTotal = round2(computedCollectedTotal + paid);
    }

    return {
      qb_invoice_id: r.qb_invoice_id,
      qb_doc_number: r.qb_doc_number,
      invoice_date: r.txn_date,
      original_amount: totalAmt,
      paid_amount: paid,
      outstanding_balance: balance,
      txn_status: r.txn_status,
      cache_voided: cacheVoided,
      mapping_voided: r.crm_sale_id ? mapVoided : null,
      mapping_method: r.mapping_method || null,
      associated_project: associatedProject,
      last_synchronized_at: r.last_synced_at,
      included_in_collected_calculation: includedInCollected,
      amount_included_in_collected: includedInCollected ? paid : 0,
      duplicate_document_number: r.qb_doc_number ? duplicateDocNumbers.has(r.qb_doc_number) : false,
    };
  });

  const unattributedExcess = round2(Math.max(0, customerTotalReceivedAllCachedInvoices - computedCollectedTotal));

  return {
    found: true,
    root_deal: { id: rootDeal.id, name: rootDeal.name, amount: round2(Number(rootDeal.amount) || 0) },
    addendum_deals: addendumDeals.map((d) => ({ id: d.id, name: d.name, amount: round2(Number(d.amount) || 0) })),
    qb_customer_id: qbCustomerId,
    invoices,
    summary: {
      computed_invoiced_total: computedInvoicedTotal,
      computed_collected_total: computedCollectedTotal,
      customer_total_received_all_cached_invoices: customerTotalReceivedAllCachedInvoices,
      // This is the fallback-pool remainder the Master Project aggregation
      // (post-fix) would allocate to any sibling deal with no direct
      // invoice of its own, or report as unattributed_customer_excess if
      // no deal can absorb it — NOT itself proof of a discrepancy; it is
      // simply customerTotalReceivedAllCachedInvoices minus what's already
      // directly claimed above.
      unclaimed_remainder_for_fallback_or_excess: unattributedExcess,
      duplicate_document_numbers_found: [...duplicateDocNumbers],
      invoices_mapped_to_a_different_deal: invoices.filter((i) => i.associated_project.startsWith('A DIFFERENT')).length,
      invoices_not_mapped_to_any_deal: invoices.filter((i) => i.associated_project === 'Not mapped to any CRM deal').length,
      voided_invoices_excluded_from_totals: invoices.filter((i) => i.cache_voided || i.mapping_voided).length,
    },
  };
}

module.exports = { getMasterProjectInvoiceReconciliation, resolveMasterProjectDeals };
