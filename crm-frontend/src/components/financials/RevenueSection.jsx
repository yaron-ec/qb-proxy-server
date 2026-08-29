import { useState } from "react";
import { formatCurrency } from "@/lib/financialCalc";

function Row({ label, value, synced, bold }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-sm ${bold ? "font-semibold text-slate-800" : "text-slate-600"}`}>{label}</span>
      <span className="flex items-center gap-2">
        {synced && (
          <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded-full whitespace-nowrap">
            Synced from QuickBooks
          </span>
        )}
        <span className={`text-sm ${bold ? "font-bold text-slate-900" : "text-slate-800"}`}>{value}</span>
      </span>
    </div>
  );
}

export default function RevenueSection({ deal, fin, canEdit, updateDeal, logActivity }) {
  const [changeOrders, setChangeOrders] = useState(deal?.financial_change_orders_amount ?? "");
  const [manualAdj, setManualAdj] = useState(deal?.financial_manual_revenue_adjustment ?? "");
  const [saving, setSaving] = useState(null);

  const save = async (field, value, label) => {
    setSaving(field);
    try {
      await updateDeal({ [field]: value === "" ? 0 : parseFloat(value) || 0 });
      await logActivity("revenue_adjusted", "Deal", `${label} updated to ${value || 0}`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <p className="typography-section-header mb-2">REVENUE</p>
      <div className="card-premium p-4 space-y-2.5">
        <Row label="Original Contract Amount" value={formatCurrency(fin.contractAmount)} synced={fin.hasQB} />
        <Row label="Approved Change Orders" value={formatCurrency(fin.changeOrders)} />
        <Row label="Total Contract Amount" value={formatCurrency(fin.totalRevenue)} bold />
        <Row label="Payments Received" value={formatCurrency(fin.paymentsReceived)} synced={fin.hasQB} />
        <Row label="Customer Balance Remaining" value={formatCurrency(fin.remainingCustomerBalance)} bold />

        {canEdit && (
          <div className="pt-3 mt-1 border-t border-slate-100 space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Manual Adjustments (stored separately)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Approved Change Orders ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={changeOrders}
                  onChange={(e) => setChangeOrders(e.target.value)}
                  onBlur={() => {
                    if (String(changeOrders) !== String(deal?.financial_change_orders_amount ?? "")) {
                      save("financial_change_orders_amount", changeOrders, "Change orders");
                    }
                  }}
                  disabled={saving === "financial_change_orders_amount"}
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Manual Revenue Adjustment ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={manualAdj}
                  onChange={(e) => setManualAdj(e.target.value)}
                  onBlur={() => {
                    if (String(manualAdj) !== String(deal?.financial_manual_revenue_adjustment ?? "")) {
                      save("financial_manual_revenue_adjustment", manualAdj, "Manual revenue adjustment");
                    }
                  }}
                  disabled={saving === "financial_manual_revenue_adjustment"}
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}