import { useState } from "react";
import { formatCurrency, safeNumber, round2 } from "@/lib/financialCalc";

const BASES = [
  { value: "total_contract", label: "Total Contract Amount" },
  { value: "payments_received", label: "Payments Received" },
  { value: "gross_profit_before_lead_cost", label: "Gross Profit Before Lead Cost" },
  { value: "custom", label: "Custom Base Amount" },
];

export default function LeadCostSection({ deal, fin, canEdit, updateDeal, logActivity }) {
  const [form, setForm] = useState({
    lead_cost_type: deal?.lead_cost_type || "percentage",
    lead_cost_percentage: deal?.lead_cost_percentage ?? "",
    lead_cost_fixed_amount: deal?.lead_cost_fixed_amount ?? "",
    lead_cost_calculation_base: deal?.lead_cost_calculation_base || "total_contract",
    lead_cost_custom_base_amount: deal?.lead_cost_custom_base_amount ?? "",
    lead_cost_notes: deal?.lead_cost_notes || "",
  });
  const [saving, setSaving] = useState(false);

  const baseLabel = BASES.find((b) => b.value === form.lead_cost_calculation_base)?.label || "";
  let baseValue = fin.totalRevenue;
  if (form.lead_cost_calculation_base === "payments_received") baseValue = fin.paymentsReceived;
  else if (form.lead_cost_calculation_base === "gross_profit_before_lead_cost") baseValue = fin.totalRevenue;
  else if (form.lead_cost_calculation_base === "custom") baseValue = safeNumber(form.lead_cost_custom_base_amount);

  const previewCost =
    form.lead_cost_type === "fixed"
      ? safeNumber(form.lead_cost_fixed_amount)
      : round2(baseValue * (safeNumber(form.lead_cost_percentage) / 100));
  const previewCompany = round2(fin.totalRevenue - previewCost);

  const save = async () => {
    setSaving(true);
    try {
      const fields = {
        lead_cost_type: form.lead_cost_type,
        lead_cost_percentage: form.lead_cost_type === "percentage" ? parseFloat(form.lead_cost_percentage) || 0 : 0,
        lead_cost_fixed_amount: form.lead_cost_type === "fixed" ? parseFloat(form.lead_cost_fixed_amount) || 0 : 0,
        lead_cost_calculation_base: form.lead_cost_calculation_base,
        lead_cost_custom_base_amount: parseFloat(form.lead_cost_custom_base_amount) || 0,
        lead_cost_notes: form.lead_cost_notes || null,
        lead_cost_amount: previewCost,
        company_share_amount: previewCompany,
      };
      await updateDeal(fields);
      await logActivity(
        "lead_cost_changed",
        "Deal",
        `Lead cost updated to ${formatCurrency(previewCost)} (${form.lead_cost_type === "percentage" ? form.lead_cost_percentage + "%" : "fixed"})`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="typography-section-header mb-2">LEAD COST & COMPANY SPLIT</p>
      <div className="card-premium p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Calculation Type</label>
            <select
              value={form.lead_cost_type}
              onChange={(e) => setForm((p) => ({ ...p, lead_cost_type: e.target.value }))}
              disabled={!canEdit}
              className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
            >
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed Amount</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Calculation Base</label>
            <select
              value={form.lead_cost_calculation_base}
              onChange={(e) => setForm((p) => ({ ...p, lead_cost_calculation_base: e.target.value }))}
              disabled={!canEdit || form.lead_cost_type === "fixed"}
              className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
            >
              {BASES.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </div>

        {form.lead_cost_type === "percentage" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Lead Cost Percentage (%)</label>
              <input
                type="number"
                step="0.01"
                value={form.lead_cost_percentage}
                onChange={(e) => setForm((p) => ({ ...p, lead_cost_percentage: e.target.value }))}
                disabled={!canEdit}
                placeholder="e.g. 12.5"
                className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
              />
            </div>
            {form.lead_cost_calculation_base === "custom" && (
              <div>
                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Custom Base Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.lead_cost_custom_base_amount}
                  onChange={(e) => setForm((p) => ({ ...p, lead_cost_custom_base_amount: e.target.value }))}
                  disabled={!canEdit}
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
                />
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Lead Cost Fixed Amount ($)</label>
            <input
              type="number"
              step="0.01"
              value={form.lead_cost_fixed_amount}
              onChange={(e) => setForm((p) => ({ ...p, lead_cost_fixed_amount: e.target.value }))}
              disabled={!canEdit}
              className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm"
            />
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Notes</label>
          <textarea
            value={form.lead_cost_notes}
            onChange={(e) => setForm((p) => ({ ...p, lead_cost_notes: e.target.value }))}
            disabled={!canEdit}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm resize-none"
          />
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
          <p>Calculation Base: <span className="font-semibold">{baseLabel}</span> — {formatCurrency(baseValue)}</p>
          {form.lead_cost_type === "percentage" && <p>Lead Cost: {form.lead_cost_percentage || 0}%</p>}
          <p>Lead Cost Amount: <span className="font-semibold">{formatCurrency(previewCost)}</span></p>
          <p>Company Share Before Other Expenses: <span className="font-semibold">{formatCurrency(previewCompany)}</span></p>
        </div>

        {canEdit && (
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Lead Cost"}
          </button>
        )}
      </div>
    </div>
  );
}