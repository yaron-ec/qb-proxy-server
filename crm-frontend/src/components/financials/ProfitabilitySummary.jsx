import { formatCurrency, formatPercent } from "@/lib/financialCalc";

/**
 * ProfitabilitySummary — the primary answer to "how profitable is this job
 * right now?" Same card/section language as every other Financials block
 * (card-premium + typography-section-header) — this used to be a full-bleed
 * dark hero with oversized monospace figures that read like a different
 * product; the numbers now carry their weight through hierarchy (label →
 * value) and restrained semantic color, not size or a dark background.
 *
 *   PROJECT VALUE − TOTAL COST = PROJECTED PROFIT
 *   PROJECTED PROFIT / PROJECT VALUE × 100 = PROFIT MARGIN
 */
export default function ProfitabilitySummary({ fin }) {
  const isNegative = fin.netProfit < 0;
  const costPct = fin.totalRevenue > 0 ? Math.min(100, Math.max(0, (fin.totalCosts / fin.totalRevenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - costPct);
  const profitColor = isNegative ? "text-rose-700" : "text-emerald-700";

  const metrics = [
    { label: "Project Value", value: formatCurrency(fin.totalRevenue), color: "text-slate-900" },
    { label: "Total Costs", value: formatCurrency(fin.totalCosts), color: "text-slate-900" },
    { label: "Projected Profit", value: formatCurrency(fin.netProfit), color: profitColor },
    { label: "Profit Margin", value: formatPercent(fin.profitMargin, 1), color: profitColor },
  ];

  return (
    <div>
      <p className="typography-section-header mb-2">JOB PROFITABILITY</p>
      <div className="card-premium p-4">
        <div className="grid grid-cols-2 lg:grid-cols-4">
          {metrics.map((m, i) => (
            <div key={m.label} className={`px-3 first:pl-0 py-1 ${i > 0 ? "lg:border-l lg:border-slate-100" : ""}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{m.label}</p>
              <p className={`text-xl sm:text-2xl font-bold tabular-nums mt-1 ${m.color}`}>{m.value}</p>
            </div>
          ))}
        </div>

        {/* Proportional cost/profit bar — the one visual element that earns
            its place here: it turns "margin 65%" into something scannable
            at a glance, without a decorative chart library. */}
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden flex">
            <div className="h-full bg-rose-400" style={{ width: `${costPct}%` }} />
            <div className={`h-full ${isNegative ? "bg-transparent" : "bg-emerald-500"}`} style={{ width: `${profitPct}%` }} />
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] font-semibold text-slate-400">
            <span>Costs {formatPercent(costPct, 0)}</span>
            <span>Profit {formatPercent(profitPct, 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
