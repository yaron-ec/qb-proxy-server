import { formatCurrency } from "@/lib/financialCalc";

function Row({ label, committed, paid, showPaid }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="flex items-baseline gap-3">
        {showPaid && (
          <span className="fin-figure-sm font-normal text-slate-400">
            {formatCurrency(paid)} paid
          </span>
        )}
        <span className="fin-figure-sm">{formatCurrency(committed)}</span>
      </span>
    </div>
  );
}

/**
 * CostBreakdown — every category that reduces job profit, in one place.
 * Subcontractor and Material are broken out explicitly (per the company's
 * own job-costing classification, set per-expense in ExpensesSection);
 * everything else from deal_expenses (permits, engineering, insurance, …)
 * rolls up into "Other Direct Costs" rather than becoming a dozen more rows.
 *
 * Committed cost (what's owed regardless of payment status) drives
 * PROJECTED PROFIT above. Paid-to-date is shown alongside, where the
 * underlying record tracks it, as a separate operational number — never
 * substituted for the committed cost.
 */
export default function CostBreakdown({ fin }) {
  const { vendorBreakdown } = fin;
  const hasCommittedVsPaidGap = fin.totalCommittedCost !== fin.totalPaidCost;

  return (
    <div>
      <p className="typography-section-header mb-2">COST BREAKDOWN</p>
      <div className="card-premium p-4">
        <Row label="Subcontractors" committed={vendorBreakdown.subcontractor.committed} paid={vendorBreakdown.subcontractor.paid} showPaid />
        <Row label="Materials" committed={vendorBreakdown.material.committed} paid={vendorBreakdown.material.paid} showPaid />
        <Row label="Other Direct Costs" committed={vendorBreakdown.other.committed} paid={vendorBreakdown.other.paid} showPaid />
        <Row label="Lead Cost" committed={fin.leadCostAmount} />
        <Row label="Sales Commission" committed={fin.salesCommissionAmount} paid={fin.commissionPaid} showPaid />
        <Row label="Financing / Loan Cost" committed={fin.totalLoanInterest} paid={fin.totalLoanInterest} showPaid />
        {fin.otherIncludedCosts > 0 && <Row label="Other" committed={fin.otherIncludedCosts} />}

        <div className="flex items-center justify-between pt-3 mt-1 border-t-2 border-slate-200">
          <span className="text-sm font-bold text-slate-800">Total Costs</span>
          <span className="fin-figure text-base">{formatCurrency(fin.totalCommittedCost)}</span>
        </div>
        {hasCommittedVsPaidGap && (
          <p className="text-[11px] text-slate-400 mt-1">
            {formatCurrency(fin.totalPaidCost)} paid so far of {formatCurrency(fin.totalCommittedCost)} committed —
            projected profit already reflects the full committed amount.
          </p>
        )}
      </div>
    </div>
  );
}
