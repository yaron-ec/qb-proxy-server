/**
 * railway dealFinancials — sale-scoped financial summary client.
 *
 *   getFinancials(dealId, saleTotal) ->
 *     { crm_sale_id, total, invoiced, paid, balance, remaining, invoiced_unpaid,
 *       payment_status, invoices, waterfall }
 *
 * Calls GET /api/v1/deals/:id/financials?sale_total=<number>
 * The backend queries qb_invoice_sale_map + qb_invoices_cache for invoices
 * mapped to THIS deal's crm_sale_id, then computes:
 *   invoiced        = SUM(invoice.total_amt)
 *   paid            = SUM(invoice.paid)  where paid = TotalAmt - Balance
 *   balance         = max(0, total - paid)   — "how much is left to collect
 *                     on the whole project." Named `balance` for historical/
 *                     backward-compatibility reasons (existing UI already
 *                     reads this field under that name) — despite the name,
 *                     this is NOT `invoiced - paid`.
 *   remaining       = same value as `balance` — the correctly-named alias.
 *                     Prefer this field in any new code.
 *   invoiced_unpaid = max(0, invoiced - paid) — the unpaid portion of what's
 *                     actually been invoiced so far (true AR/collections
 *                     balance). This is a distinct number from `balance`/
 *                     `remaining` whenever the full project hasn't been
 *                     fully invoiced yet.
 *
 * QuickBooks is authoritative. No customer-level aggregation. No double counting.
 *
 * waterfall: customer payment waterfall allocation — allocates customer-level
 * QB received money across eligible Deals chronologically. Separate from
 * invoice ownership. waterfall.this_deal_allocation.allocated_paid is the
 * authoritative PAID amount for this Deal (and `paid`/`balance`/`remaining`/
 * `invoiced_unpaid` above are all recomputed against it when it applies).
 */
import { apiCall } from './client';

export async function getFinancials(dealId, saleTotal) {
  if (!dealId) throw new Error('dealId is required');
  const total = Number(saleTotal) || 0;
  return apiCall(`/api/v1/deals/${dealId}/financials?sale_total=${encodeURIComponent(total)}`, { method: 'GET' });
}
