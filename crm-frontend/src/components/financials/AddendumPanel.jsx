/**
 * AddendumPanel ("Master Project Summary") — CRM repair item 1 (November
 * 2026): "Customer → Main Project → Addendums," extended with the
 * consolidated Master Project financial view (the November 2026 Lalani
 * invoice-attribution correction): Invoiced / Collected / Outstanding /
 * Total Costs / Projected Profit / Profit Margin summed across the parent
 * deal and every approved addendum, with no double-counting — reusing
 * lib/dealFinancialAggregation.js#computeMasterFinancials (one server-side
 * computation, surfaced via the existing GET /:id/addendums response's new
 * `master` field) rather than re-deriving any of it in the browser.
 *
 * Shown ALWAYS-VISIBLE, directly below the Financial Summary hero — not
 * buried in the Expandable Details accordion — on BOTH the parent's own
 * page and any of its addendums' own pages, which return the identical
 * consolidated totals (the backend resolves to the root/master deal
 * either way). This is a production correction: the prior version only
 * showed the Original/Addendums/Combined CONTRACT VALUE (no invoiced/
 * collected/profit figures at all) and the "Convert to Addendum" action's
 * own old entry point was buried inside the collapsed, generically-named
 * "Documents & QuickBooks Mapping" accordion section — that action now
 * lives exclusively in the header "+ Add Addendum" modal
 * (components/AddAddendumModal.jsx); this panel is display-only.
 *
 * Admin/manager only (mirrors ProfitabilitySummary/CostBreakdown's own
 * role boundary — profit/margin data is never shown to sales_rep).
 */
import { useState, useEffect, useCallback } from "react";
import * as railwayDeals from "@/api/railway/deals";
import { Link2, AlertTriangle } from "lucide-react";
import { formatCurrency, formatPercent } from "@/lib/financialCalc";

const NAVY = "#0B2D5C";
const GOLD = "#C9A227";

export default function AddendumPanel({ deal, lead, isAdmin, refreshKey }) {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const res = await railwayDeals.getAddendums(deal.id);
      setData(res);
    } catch (e) {
      setData(null);
    }
  }, [deal?.id]);

  // Re-checks GET /:id/addendums whenever `refreshKey` changes — the
  // header "+ Add Addendum" modal links a SIBLING deal to this one via
  // `parent_deal_id` on the SIBLING's own row, so this deal's own id/
  // lead_id/amount never change; without an explicit refresh signal this
  // panel would keep showing stale (pre-link) data until a full page
  // reload. DealDetail.jsx bumps refreshKey on a successful link.
  useEffect(() => { load(); }, [load, refreshKey]);

  if (!data) return null;

  const hasAddendums = Array.isArray(data.addendums) && data.addendums.length > 0;
  const isAddendum = !!deal.parent_deal_id;

  if (!hasAddendums && !isAddendum) return null; // a plain, single-deal project has nothing to show here

  const m = data.master;

  const metrics = m
    ? [
        { label: "Invoiced", value: formatCurrency(m.invoiced) },
        { label: "Collected", value: formatCurrency(m.collected) },
        { label: "Outstanding", value: formatCurrency(m.outstanding) },
        { label: "Total Costs", value: formatCurrency(m.total_costs) },
      ]
    : [];

  return (
    <div data-testid="master-project-summary" className="rounded-xl border border-slate-200 overflow-hidden shadow-sm bg-white">
      <div
        className="px-4 sm:px-6 py-3 sm:py-4 border-b-[3px] flex items-center justify-between"
        style={{ background: NAVY, borderBottomColor: GOLD }}
      >
        <p className="text-sm sm:text-base font-bold text-white tracking-wide flex items-center gap-2">
          <Link2 className="w-4 h-4" style={{ color: GOLD }} />
          Master Project Summary
        </p>
        {hasAddendums && (
          <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: GOLD }}>
            Combined Project
          </p>
        )}
      </div>

      <div className="p-4 sm:p-6">
        {isAddendum && (
          <p className="text-xs text-slate-600 mb-3">
            This project is an <span className="font-semibold">addendum</span> of another project on this lead —
            the figures below combine both.
          </p>
        )}

        {hasAddendums && (
          <>
            <div className="text-xs text-slate-700 space-y-1 mb-4">
              <div className="flex justify-between"><span>Original Contract</span><span className="font-semibold">{formatCurrency(data.original_contract_amount)}</span></div>
              <div className="flex justify-between"><span>Approved Addendums ({data.addendums.length})</span><span className="font-semibold">{formatCurrency(data.approved_addendums_amount)}</span></div>
              <div className="flex justify-between border-t border-slate-100 pt-1 text-sm"><span className="font-bold">Combined Contract Value</span><span className="font-bold" style={{ color: GOLD }}>{formatCurrency(data.total_approved_contract)}</span></div>
              <ul className="mt-2 space-y-0.5">
                {data.addendums.map((a) => (
                  <li key={a.id} className="text-[11px] text-slate-500">• {a.name} — {formatCurrency(a.amount)}</li>
                ))}
              </ul>
            </div>

            {m && (
              <>
                {m.has_invoiced_vs_contract_discrepancy && (
                  <div data-testid="invoiced-vs-contract-discrepancy-banner" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
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

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
                  {metrics.map((metric) => (
                    <div key={metric.label} data-testid={`master-fin-metric-${metric.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">{metric.label}</p>
                      <p className="text-lg sm:text-xl font-bold tabular-nums mt-1 text-slate-900">{metric.value}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100 flex gap-8">
                  <div data-testid="master-fin-metric-profit">
                    <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Projected Profit</p>
                    <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: m.projected_profit < 0 ? "#be123c" : GOLD }}>
                      {formatCurrency(m.projected_profit)}
                    </p>
                  </div>
                  <div data-testid="master-fin-metric-margin">
                    <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Profit Margin</p>
                    <p className="text-xl sm:text-2xl font-bold tabular-nums mt-1" style={{ color: m.projected_profit < 0 ? "#be123c" : GOLD }}>
                      {formatPercent(m.profit_margin_pct, 1)}
                    </p>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
