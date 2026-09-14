/**
 * railway dealFinancials — sale-scoped financial summary client.
 *
 *   getFinancials(dealId, saleTotal) -> { crm_sale_id, total, invoiced, paid, balance, payment_status, invoices }
 *
 * Calls GET /api/v1/deals/:id/financials?sale_total=<number>
 * The backend queries qb_invoice_sale_map + qb_invoices_cache for invoices
 * mapped to THIS deal's crm_sale_id, then computes:
 *   invoiced = SUM(invoice.total_amt)
 *   paid     = SUM(invoice.paid)  where paid = TotalAmt - Balance
 *   balance  = max(0, total - paid)
 *
 * QuickBooks is authoritative. No customer-level aggregation. No double counting.
 */
import { apiCall } from './client';

export async function getFinancials(dealId, saleTotal) {
  if (!dealId) throw new Error('dealId is required');
  const total = Number(saleTotal) || 0;
  return apiCall(`/api/v1/deals/${dealId}/financials?sale_total=${encodeURIComponent(total)}`, { method: 'GET' });
}
