import { formatCurrency, formatPercent } from "@/lib/financialCalc";

/**
 * ProfitabilitySummary — the primary answer to "how profitable is this job
 * right now?" Four numbers, visually dominant, everything else on the
 * Financials tab is detail underneath this.
 *
 *   PROJECT VALUE − TOTAL COST = PROJECTED PROFIT
 *   PROJECTED PROFIT / PROJECT VALUE × 100 = PROFIT MARGIN
 */
export default function ProfitabilitySummary({ fin }) {
  const isNegative = fin.netProfit < 0;
  const costPct = fin.totalRevenue > 0 ? Math.min(100, Math.max(0, (fin.totalCosts / fin.totalRevenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - costPct);

  return (
    <div className="card-premium p-5 sm:p-6 bg-gradient-to-br from-slate-900 to-slate-800 border-slate-800 text-white">
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-4">Job Profitability</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Project Value</p>
          <p className="fin-figure-lg text-white mt-1">{formatCurrency(fin.totalRevenue)}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total Cost</p>
          <p className="fin-figure-lg text-rose-300 mt-1">{formatCurrency(fin.totalCosts)}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Projected Profit</p>
          <p className={`fin-figure-lg mt-1 ${isNegative ? "text-rose-300" : "text-emerald-300"}`}>
            {formatCurrency(fin.netProfit)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Profit Margin</p>
          <p className={`fin-figure-lg mt-1 ${isNegative ? "text-rose-300" : "text-emerald-300"}`}>
            {formatPercent(fin.profitMargin, 1)}
          </p>
        </div>
      </div>

      {/* Proportional cost/profit bar — the one visual element that earns its
          place here: it turns "margin 65%" into something scannable at a
          glance, without a decorative chart library. */}
      <div className="mt-5">
        <div className="h-2.5 w-full rounded-full bg-white/10 overflow-hidden flex">
          <div className="h-full bg-rose-400/80" style={{ width: `${costPct}%` }} />
          <div className={`h-full ${isNegative ? "bg-transparent" : "bg-emerald-400/80"}`} style={{ width: `${profitPct}%` }} />
        </div>
        <div className="flex justify-between mt-1.5 text-[10px] font-semibold text-slate-400">
          <span>Costs {formatPercent(costPct, 0)}</span>
          <span>Profit {formatPercent(profitPct, 0)}</span>
        </div>
      </div>
    </div>
  );
}
