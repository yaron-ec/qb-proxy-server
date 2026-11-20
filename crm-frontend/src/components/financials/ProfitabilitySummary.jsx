import { formatCurrency, formatPercent } from "@/lib/financialCalc";

// EC Construction Group brand colors — the SAME exact values every branded
// email (lib/emailTemplates.js's NAVY/GOLD constants) already uses. Never
// invented here; reused so the Financials summary matches every other
// branded surface in the product rather than introducing a third palette.
const NAVY = "#0B2D5C";
const GOLD = "#C9A227";

/**
 * ProfitabilitySummary — the Financials tab's "Financial Summary" hero: the
 * one simple, plain-English answer to "what's the state of this job's
 * money?" before anyone has to open a single expandable detail section
 * below it. Navy/gold/white, matching the brand's own established colors
 * (lib/emailTemplates.js).
 *
 *   CONTRACT TOTAL − TOTAL COST = PROFIT
 *   PROFIT / CONTRACT TOTAL × 100 = MARGIN
 *
 * MASTER PROJECT CONSOLIDATION (November 2026 production correction): a
 * real production report found this hero still computing from just THIS
 * deal's own `fin` even while the separate Master Project Summary panel
 * below it showed the combined parent+addendum totals — two different
 * numbers on the same page for the same job, exactly the "avoid
 * conflicting totals" complaint. When an optional `master` prop is passed
 * (lib/dealFinancialAggregation.js's consolidated output — the SAME single
 * computation the Master Project Summary panel reads, fetched once by the
 * parent FinancialsTab and shared, never re-derived here), this hero shows
 * the COMBINED figures instead of this one deal's own slice, with a
 * "Combined Project" badge so it's unmistakable these are project-wide
 * totals. A deal with no addendums (master == null) is completely
 * unaffected — same single-deal numbers as before.
 */
export default function ProfitabilitySummary({ fin, master }) {
  const isConsolidated = !!master;
  const totalRevenue = isConsolidated ? master.total_approved_contract : fin.totalRevenue;
  const collected = isConsolidated ? master.collected : fin.paymentsReceived;
  const outstanding = isConsolidated ? master.outstanding : fin.remainingCustomerBalance;
  const totalCosts = isConsolidated ? master.total_costs : fin.totalCosts;
  const netProfit = isConsolidated ? master.projected_profit : fin.netProfit;
  const profitMargin = isConsolidated ? master.profit_margin_pct : fin.profitMargin;

  const isNegative = netProfit < 0;
  const costPct = totalRevenue > 0 ? Math.min(100, Math.max(0, (totalCosts / totalRevenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - costPct);
  const profitColor = isNegative ? "#be123c" : GOLD;

  // "Collected" is derived from each invoice's QuickBooks balance
  // (total_amt − balance) — a known, honest limitation (never silently
  // hidden, per a real production finding): a zero balance can also result
  // from a credit memo or a manual write-off/adjustment in QuickBooks, not
  // only a genuine cash payment. This codebase's qb_payments_cache table
  // is customer-level only (no per-invoice linkage to a specific Payment
  // object), so there is currently no way to distinguish the two from
  // cached data alone — verifying this precisely would mean building new
  // QuickBooks sync logic (capturing Payment/CreditMemo line-level
  // linkage) that cannot be tested without live QuickBooks access, so it
  // is flagged here rather than guessed at or silently assumed correct.
  const collectedTooltip = "Based on each invoice's QuickBooks balance. A zero balance can also reflect a credit memo or adjustment, not only a cash payment — not yet verified against individual QuickBooks Payment records.";

  const metrics = [
    { label: isConsolidated ? "Combined Contract Value" : "Contract Total", value: formatCurrency(totalRevenue) },
    { label: "Collected", value: formatCurrency(collected), tooltip: collectedTooltip },
    { label: "Balance Due", value: formatCurrency(outstanding) },
    { label: "Total Cost", value: formatCurrency(totalCosts) },
  ];

  return (
    <div data-testid="financial-summary-card" className="rounded-xl border border-slate-200 overflow-hidden shadow-sm bg-white">
      <div
        className="px-4 sm:px-6 py-3 sm:py-4 border-b-[3px] flex items-center justify-between gap-3"
        style={{ background: NAVY, borderBottomColor: GOLD }}
      >
        <p className="text-sm sm:text-base font-bold text-white tracking-wide">Financial Summary</p>
        <div className="flex items-center gap-2">
          {isConsolidated && (
            <span data-testid="financial-summary-consolidated-badge" className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-white/90 bg-white/10 px-2 py-0.5 rounded-full border border-white/20">
              Combined Project
            </span>
          )}
          <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: GOLD }}>
            {isNegative ? "Over Budget" : "On Track"}
          </p>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
          {metrics.map((m) => (
            <div key={m.label} data-testid={`fin-metric-${m.label.toLowerCase().replace(/\s+/g, "-")}`} title={m.tooltip}>
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {m.label}{m.tooltip && <span className="ml-1 text-slate-400 cursor-help" aria-hidden="true">ⓘ</span>}
              </p>
              <p className="text-lg sm:text-2xl font-bold tabular-nums mt-1 text-slate-900">{m.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 pt-5 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div className="flex gap-8">
            <div data-testid="fin-metric-profit">
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Profit</p>
              <p className="text-2xl sm:text-3xl font-bold tabular-nums mt-1" style={{ color: profitColor }}>
                {formatCurrency(netProfit)}
              </p>
            </div>
            <div data-testid="fin-metric-margin">
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Margin</p>
              <p className="text-2xl sm:text-3xl font-bold tabular-nums mt-1" style={{ color: profitColor }}>
                {formatPercent(profitMargin, 1)}
              </p>
            </div>
          </div>

          {/* Proportional cost/profit bar — the one visual element that earns
              its place: turns "margin 65%" into something scannable at a
              glance, without a decorative chart library. */}
          <div className="w-full sm:w-56">
            <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden flex">
              <div className="h-full bg-rose-400" style={{ width: `${costPct}%` }} />
              <div className="h-full" style={{ width: `${profitPct}%`, background: isNegative ? "transparent" : GOLD }} />
            </div>
            <div className="flex justify-between mt-1.5 text-[10px] font-semibold text-slate-400">
              <span>Cost {formatPercent(costPct, 0)}</span>
              <span>Profit {formatPercent(profitPct, 0)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
