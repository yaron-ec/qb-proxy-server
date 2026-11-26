import { useState } from "react";
import { Search, X, Loader2, AlertTriangle, ShieldAlert } from "lucide-react";
import * as railwayDeals from "@/api/railway/deals";
import { formatCurrency } from "@/lib/financialCalc";
import { fmtBusinessDate, fmtDate } from "@/lib/formatters";

/**
 * InvoiceReconciliationPanel — admin-only "Invoice Reconciliation" button +
 * modal for the Financial Summary (November 2026, built for the Lalani
 * $42,031-vs-$40,934 discrepancy — see CLAUDE.md's "Lalani $1,097
 * discrepancy — itemized, read-only invoice reconciliation diagnostic"
 * section).
 *
 * Reuses the EXISTING, already-deployed PR #84 backend endpoint
 * (GET /api/v1/deals/:id/invoice-reconciliation) through the SAME
 * authenticated railwayDeals API client — and therefore the SAME session/
 * JWT handling — every other Financials-tab call already uses. No separate
 * auth mechanism, no token ever touches this component's own code, no raw
 * SQL/DB access. Purely a display of what the backend already computed;
 * this component issues no write of any kind and makes no QuickBooks call
 * itself (the backend route is the SAME READ-ONLY module PR #84 proved
 * never mutates qb_invoices_cache/qb_invoice_sale_map).
 *
 * Fetched ONLY on demand (the "Invoice Reconciliation" button click) —
 * never auto-loaded with the rest of the Financials tab, since this is a
 * diagnostic tool for an exceptional investigation, not a figure every
 * page load needs. Admin-only on BOTH sides: this component is rendered
 * only when the caller passes isAdmin (FinancialsTab already knows the
 * role), and the backend route itself independently enforces
 * requireAuth+requireAdmin regardless of what the frontend does — a
 * non-admin hitting the route directly still gets a real 403, this button
 * is only a courtesy.
 */
export default function InvoiceReconciliationPanel({ dealId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const openPanel = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await railwayDeals.getInvoiceReconciliation(dealId);
      setData(res);
    } catch (e) {
      setError(e?.data?.message || e?.message || "Failed to load invoice reconciliation.");
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    setOpen(false);
    // Deliberately keep `data` cached in memory until the next explicit
    // "Invoice Reconciliation" click — closing/reopening within the same
    // page visit shouldn't re-fetch unless the admin wants a fresh read
    // (there is no live-refresh need here; the underlying cache changes at
    // most every 15 minutes via the QB sync cron).
  };

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        data-testid="invoice-reconciliation-button"
        className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-white/90 bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-full border border-white/20 transition-colors"
        title="Admin-only: itemized, read-only reconciliation of every cached QuickBooks invoice behind this project's Collected total"
      >
        <Search className="w-3 h-3" />
        Invoice Reconciliation
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={close}
          data-testid="invoice-reconciliation-modal-backdrop"
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Search className="w-5 h-5 text-amber-600" />
                Invoice Reconciliation
              </h2>
              <button onClick={close} className="text-slate-400 hover:text-slate-600" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto px-6 py-4 flex-1">
              <p className="text-xs text-slate-500 mb-4">
                Itemized, read-only list of every QuickBooks invoice cached for this project's customer — shows
                exactly which records produce the Collected total above. This is <span className="font-semibold">cached data from
                this CRM's own database</span>, last refreshed by the sync listed per row below — not a live QuickBooks lookup made
                just now. No record shown here is modified, voided, or reassigned by viewing this panel.
              </p>

              {loading && (
                <div className="flex items-center justify-center py-12 text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                </div>
              )}

              {!loading && error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
                  {error}
                </div>
              )}

              {!loading && !error && data && !data.qb_customer_id && (
                <p className="text-sm text-slate-500 py-6 text-center">
                  {data.note || "No QuickBooks customer is linked to this project — nothing to reconcile."}
                </p>
              )}

              {!loading && !error && data?.qb_customer_id && (
                <InvoiceReconciliationContent data={data} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InvoiceReconciliationContent({ data }) {
  const s = data.summary;
  const gap = Number(s.customer_total_received_all_cached_invoices) - Number(s.computed_collected_total);

  return (
    <div className="space-y-5" data-testid="invoice-reconciliation-content">
      {/* Calculated totals — clearly labeled as cached/computed, never
          implied to be a live-verified QuickBooks figure. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SummaryTile label="Invoiced (counted)" value={formatCurrency(s.computed_invoiced_total)} />
        <SummaryTile label="Collected (counted)" value={formatCurrency(s.computed_collected_total)} highlight />
        <SummaryTile
          label="Customer total received (all cached invoices)"
          value={formatCurrency(s.customer_total_received_all_cached_invoices)}
          tooltip="Every cached invoice for this QuickBooks customer, mapped or not, excluding only voided cache rows — the same figure the payment waterfall sums."
        />
      </div>

      {gap !== 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <span className="font-bold">
            {formatCurrency(Math.abs(gap))} of this customer's total cached payments {gap > 0 ? "is not" : "exceeds what is"} currently
            counted toward this project's Collected total
          </span>{" "}
          — this is the unclaimed/fallback remainder figure, not itself proof of an error. Review the warnings on
          individual rows below before drawing a conclusion.
        </div>
      )}

      {(s.duplicate_document_numbers_found?.length > 0 ||
        s.invoices_mapped_to_a_different_deal > 0 ||
        s.invoices_not_mapped_to_any_deal > 0 ||
        s.voided_invoices_excluded_from_totals > 0) && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
          <p className="font-bold text-slate-800 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" /> Flags found in this data
          </p>
          {s.duplicate_document_numbers_found?.length > 0 && (
            <p>• {s.duplicate_document_numbers_found.length} duplicate document number(s): {s.duplicate_document_numbers_found.join(", ")}</p>
          )}
          {s.invoices_mapped_to_a_different_deal > 0 && (
            <p>• {s.invoices_mapped_to_a_different_deal} invoice(s) mapped to a different, unrelated deal for this customer</p>
          )}
          {s.invoices_not_mapped_to_any_deal > 0 && (
            <p>• {s.invoices_not_mapped_to_any_deal} invoice(s) not mapped to any CRM deal</p>
          )}
          {s.voided_invoices_excluded_from_totals > 0 && (
            <p>• {s.voided_invoices_excluded_from_totals} voided invoice(s), correctly excluded from totals (shown below for reference)</p>
          )}
        </div>
      )}

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide">
            <tr>
              <th className="text-left px-2.5 py-2 font-semibold">Invoice #</th>
              <th className="text-left px-2.5 py-2 font-semibold">Date</th>
              <th className="text-right px-2.5 py-2 font-semibold">Original</th>
              <th className="text-right px-2.5 py-2 font-semibold">Paid</th>
              <th className="text-right px-2.5 py-2 font-semibold">Balance</th>
              <th className="text-left px-2.5 py-2 font-semibold">Status</th>
              <th className="text-left px-2.5 py-2 font-semibold">Project</th>
              <th className="text-left px-2.5 py-2 font-semibold">Last Synced</th>
              <th className="text-right px-2.5 py-2 font-semibold">In Collected</th>
              <th className="text-left px-2.5 py-2 font-semibold">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((inv) => (
              <tr key={inv.qb_invoice_id} className="border-t border-slate-100" data-testid="invoice-reconciliation-row">
                <td className="px-2.5 py-2 font-mono text-slate-700">
                  {inv.qb_doc_number || "—"}
                  <div className="text-[10px] text-slate-400">QB id {inv.qb_invoice_id}</div>
                </td>
                <td className="px-2.5 py-2 text-slate-600">{fmtBusinessDate(inv.invoice_date)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{formatCurrency(inv.original_amount)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{formatCurrency(inv.paid_amount)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{formatCurrency(inv.outstanding_balance)}</td>
                <td className="px-2.5 py-2 text-slate-600">{inv.txn_status || "—"}</td>
                <td className="px-2.5 py-2 text-slate-600">{inv.associated_project}</td>
                <td className="px-2.5 py-2 text-slate-500">{fmtDate(inv.last_synchronized_at)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums font-semibold">
                  {inv.included_in_collected_calculation ? formatCurrency(inv.amount_included_in_collected) : "—"}
                </td>
                <td className="px-2.5 py-2">
                  <div className="flex flex-col gap-0.5">
                    {inv.duplicate_document_number && <WarningBadge>Duplicate doc #</WarningBadge>}
                    {inv.cache_voided && <WarningBadge>Voided (cache)</WarningBadge>}
                    {inv.mapping_voided && <WarningBadge>Voided (mapping)</WarningBadge>}
                    {inv.associated_project === "Not mapped to any CRM deal" && <WarningBadge>Unmapped</WarningBadge>}
                    {inv.associated_project?.startsWith("A DIFFERENT") && <WarningBadge>Wrong project</WarningBadge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
        <ShieldAlert className="w-3 h-3" /> Read-only diagnostic. No invoice, payment, or mapping record can be changed from this panel.
      </p>
    </div>
  );
}

function SummaryTile({ label, value, highlight, tooltip }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`} title={tooltip}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-base font-bold tabular-nums mt-0.5 text-slate-900">{value}</p>
    </div>
  );
}

function WarningBadge({ children }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
      <AlertTriangle className="w-2.5 h-2.5" /> {children}
    </span>
  );
}
