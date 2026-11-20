/**
 * AddendumPanel ("Master Project Summary") — CRM repair item 1 (November
 * 2026): "Customer → Main Project → Addendums."
 *
 * Shows the CONTRACT STRUCTURE (Original Contract / Approved Addendums /
 * Combined Contract Value + the addendum list) and the invoiced-vs-
 * contract discrepancy banner. Pure display, receives `data` (the GET
 * /:id/addendums response) as a prop from FinancialsTab — fetched ONCE
 * there and shared with ProfitabilitySummary, so the two panels can never
 * show conflicting numbers for the same project (a real production
 * report this pass fixes: the two panels previously fetched independently
 * and the hero never even showed the combined total at all).
 *
 * The consolidated financial METRICS (Invoiced/Collected/Outstanding/
 * Total Costs/Projected Profit/Margin) live in ProfitabilitySummary's own
 * hero now, not duplicated here — this panel is the contract-structure
 * and discrepancy view, not a second copy of the same numbers.
 *
 * The "Convert to Addendum" action lives exclusively in the header
 * "+ Add Addendum" modal (components/AddAddendumModal.jsx) — this panel
 * is display-only.
 */
import { Link2, AlertTriangle } from "lucide-react";
import { formatCurrency } from "@/lib/financialCalc";

export default function AddendumPanel({ deal, data }) {
  if (!data) return null;

  const hasAddendums = Array.isArray(data.addendums) && data.addendums.length > 0;
  const isAddendum = !!deal.parent_deal_id;

  if (!hasAddendums && !isAddendum) return null; // a plain, single-deal project has nothing to show here

  const m = data.master;

  return (
    <div data-testid="master-project-summary" className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="w-4 h-4 text-amber-600" />
        <h3 className="text-sm font-bold text-slate-800">Master Project Summary</h3>
      </div>

      {isAddendum && (
        <p className="text-xs text-slate-600 mb-2">
          This project is an <span className="font-semibold">addendum</span> of another project on this lead —
          the Financial Summary above combines both.
        </p>
      )}

      {hasAddendums && (
        <>
          <div className="text-xs text-slate-700 space-y-1">
            <div className="flex justify-between"><span>Original Contract</span><span className="font-semibold">{formatCurrency(data.original_contract_amount)}</span></div>
            <div className="flex justify-between"><span>Approved Addendums ({data.addendums.length})</span><span className="font-semibold">{formatCurrency(data.approved_addendums_amount)}</span></div>
            <div className="flex justify-between border-t border-slate-100 pt-1 text-sm"><span className="font-bold">Combined Contract Value</span><span className="font-bold text-amber-700">{formatCurrency(data.total_approved_contract)}</span></div>
            <ul className="mt-2 space-y-0.5">
              {data.addendums.map((a) => (
                <li key={a.id} className="text-[11px] text-slate-500">• {a.name} — {formatCurrency(a.amount)}</li>
              ))}
            </ul>
          </div>

          {m && m.has_invoiced_vs_contract_discrepancy && (
            <div data-testid="invoiced-vs-contract-discrepancy-banner" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900">
                  <p className="font-bold">
                    Invoiced ({formatCurrency(m.invoiced)}) {m.invoiced_vs_contract_discrepancy > 0 ? "exceeds" : "is less than"} the Combined Contract Value ({formatCurrency(data.total_approved_contract)}) by {formatCurrency(Math.abs(m.invoiced_vs_contract_discrepancy))}.
                  </p>
                  <p className="mt-1 text-amber-800">
                    This is flagged for admin review, not automatically corrected — verify each deal's invoices
                    below against the real QuickBooks records before taking any action.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {m.per_deal.map((d) => (
                      <li key={d.deal_id} className="text-[11px]">
                        • {d.deal_name}: invoiced {formatCurrency(d.invoiced)}, collected {formatCurrency(d.collected)}
                        {d.used_waterfall_fallback && <span className="text-amber-600"> (no direct invoice mapping — estimated)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
