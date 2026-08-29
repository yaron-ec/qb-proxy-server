import { formatCurrency, formatPercent } from "@/lib/financialCalc";

function Card({ label, value, tone }) {
  const tones = {
    default: "text-slate-800",
    positive: "text-emerald-700",
    negative: "text-rose-700",
    muted: "text-slate-500",
  };
  return (
    <div className="card-premium p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 leading-none">{label}</p>
      <p className={`text-sm font-bold mt-1 ${tones[tone] || tones.default}`}>{value}</p>
    </div>
  );
}

export default function FinancialSummary({ fin }) {
  return (
    <div>
      <p className="typography-section-header mb-2">FINANCIAL SUMMARY</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <Card label="Total Contract" value={formatCurrency(fin.totalRevenue)} />
        <Card label="Payments Received" value={formatCurrency(fin.paymentsReceived)} tone="positive" />
        <Card label="Customer Balance" value={formatCurrency(fin.remainingCustomerBalance)} tone="muted" />
        <Card label="Total Lead Cost" value={formatCurrency(fin.leadCostAmount)} tone="negative" />
        <Card label="Sales Commission" value={formatCurrency(fin.salesCommissionAmount)} tone="negative" />
        <Card label="Vendor Expenses" value={formatCurrency(fin.totalVendorExpenses)} tone="negative" />
        <Card label="Loan Interest" value={formatCurrency(fin.totalLoanInterest)} tone="negative" />
        <Card label="Total Costs" value={formatCurrency(fin.totalCosts)} tone="negative" />
        <Card label="Net Profit" value={formatCurrency(fin.netProfit)} tone={fin.netProfit >= 0 ? "positive" : "negative"} />
        <Card label="Profit Margin" value={formatPercent(fin.profitMargin)} tone={fin.profitMargin >= 0 ? "positive" : "negative"} />
      </div>
    </div>
  );
}