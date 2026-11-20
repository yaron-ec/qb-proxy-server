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
 * (lib/emailTemplates.js) — this redesign is a direct, explicit product
 * requirement (November 2026), distinct from and superseding the PRIOR
 * redesign's move away from a dark hero: that pass's actual complaint was
 * numbers carrying their weight through raw SIZE instead of label/value
 * hierarchy, not that navy/gold itself was wrong — this version keeps a
 * disciplined label-over-value hierarchy while still using the brand's
 * navy/gold/white, satisfying both concerns.
 *
 *   CONTRACT TOTAL − TOTAL COST = PROFIT
 *   PROFIT / CONTRACT TOTAL × 100 = MARGIN
 *
 * Plain-English terminology throughout (never "netProfit"/"totalRevenue"
 * jargon on screen) — see fin.remainingCustomerBalance's own documented
 * meaning in lib/financialCalc.js ("remaining": contract value minus paid,
 * the whole-job balance) for why "Balance Due" reads from that field, not
 * fin.balance (the narrower invoiced-minus-paid figure — CLAUDE.md's own
 * documented balance/remaining distinction).
 */
export default function ProfitabilitySummary({ fin }) {
  const isNegative = fin.netProfit < 0;
  const costPct = fin.totalRevenue > 0 ? Math.min(100, Math.max(0, (fin.totalCosts / fin.totalRevenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - costPct);
  const profitColor = isNegative ? "#be123c" : GOLD;

  const metrics = [
    { label: "Contract Total", value: formatCurrency(fin.totalRevenue) },
    { label: "Collected", value: formatCurrency(fin.paymentsReceived) },
    { label: "Balance Due", value: formatCurrency(fin.remainingCustomerBalance) },
    { label: "Total Cost", value: formatCurrency(fin.totalCosts) },
  ];

  return (
    <div data-testid="financial-summary-card" className="rounded-xl border border-slate-200 overflow-hidden shadow-sm bg-white">
      <div
        className="px-4 sm:px-6 py-3 sm:py-4 border-b-[3px] flex items-center justify-between"
        style={{ background: NAVY, borderBottomColor: GOLD }}
      >
        <p className="text-sm sm:text-base font-bold text-white tracking-wide">Financial Summary</p>
        <p className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: GOLD }}>
          {isNegative ? "Over Budget" : "On Track"}
        </p>
      </div>

      <div className="p-4 sm:p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
          {metrics.map((m) => (
            <div key={m.label} data-testid={`fin-metric-${m.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">{m.label}</p>
              <p className="text-lg sm:text-2xl font-bold tabular-nums mt-1 text-slate-900">{m.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 pt-5 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div className="flex gap-8">
            <div data-testid="fin-metric-profit">
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Profit</p>
              <p className="text-2xl sm:text-3xl font-bold tabular-nums mt-1" style={{ color: profitColor }}>
                {formatCurrency(fin.netProfit)}
              </p>
            </div>
            <div data-testid="fin-metric-margin">
              <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-slate-500">Margin</p>
              <p className="text-2xl sm:text-3xl font-bold tabular-nums mt-1" style={{ color: profitColor }}>
                {formatPercent(fin.profitMargin, 1)}
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
