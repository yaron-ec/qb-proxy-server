import { useState } from "react";
import * as railwayDealCommissions from "@/api/railway/dealCommissions";
import { formatCurrency, safeNumber, round2, commissionAmount } from "@/lib/financialCalc";
import { Plus } from "lucide-react";

const STATUSES = ["Estimated", "Approved", "Partially Paid", "Paid", "Cancelled"];
const BASES = [
  { value: "total_contract", label: "Total Contract Amount" },
  { value: "payments_received", label: "Payments Received" },
  { value: "gross_profit_before_commission", label: "Gross Profit Before Commission" },
  { value: "custom", label: "Custom Base Amount" },
];

function StatusBadge({ status }) {
  const map = {
    Estimated: "bg-slate-100 text-slate-600",
    Approved: "bg-blue-100 text-blue-700",
    "Partially Paid": "bg-amber-100 text-amber-700",
    Paid: "bg-emerald-100 text-emerald-700",
    Cancelled: "bg-rose-100 text-rose-700",
  };
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${map[status] || "bg-slate-100 text-slate-600"}`}>{status}</span>;
}

function Totals({ label, value }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-sm font-bold text-slate-800">{value}</p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">{label}</label>
      {children}
    </div>
  );
}

function CommissionModal({ editing, setEditing, ctx, saving, onSave, onClose }) {
  let base = ctx.totalRevenue;
  if (editing.calculation_base === "payments_received") base = ctx.paymentsReceived;
  else if (editing.calculation_base === "gross_profit_before_commission") base = ctx.grossProfitBeforeCommission;
  else if (editing.calculation_base === "custom") base = safeNumber(editing.custom_base_amount);
  const preview =
    editing.commission_type === "fixed"
      ? safeNumber(editing.commission_fixed_amount)
      : round2(base * (safeNumber(editing.commission_percentage) / 100));
  const INP = "w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800">{editing.id ? "Edit Commission" : "Add Commission"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Recipient Name"><input value={editing.recipient_name || ""} onChange={(e) => setEditing((p) => ({ ...p, recipient_name: e.target.value }))} className={INP} /></Field>
            <Field label="Recipient User ID (optional)"><input value={editing.recipient_user_id || ""} onChange={(e) => setEditing((p) => ({ ...p, recipient_user_id: e.target.value }))} className={INP} /></Field>
            <Field label="Type"><select value={editing.commission_type} onChange={(e) => setEditing((p) => ({ ...p, commission_type: e.target.value }))} className={INP}><option value="percentage">Percentage</option><option value="fixed">Fixed</option></select></Field>
            <Field label="Calculation Base"><select value={editing.calculation_base} onChange={(e) => setEditing((p) => ({ ...p, calculation_base: e.target.value }))} className={INP}>{BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></Field>
            {editing.commission_type === "percentage" ? (
              <Field label="Percentage (%)"><input type="number" step="0.01" value={editing.commission_percentage || ""} onChange={(e) => setEditing((p) => ({ ...p, commission_percentage: e.target.value }))} className={INP} /></Field>
            ) : (
              <Field label="Fixed Amount ($)"><input type="number" step="0.01" value={editing.commission_fixed_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, commission_fixed_amount: e.target.value }))} className={INP} /></Field>
            )}
            {editing.calculation_base === "custom" && (
              <Field label="Custom Base Amount ($)"><input type="number" step="0.01" value={editing.custom_base_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, custom_base_amount: e.target.value }))} className={INP} /></Field>
            )}
            <Field label="Paid Amount ($)"><input type="number" step="0.01" value={editing.paid_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, paid_amount: e.target.value }))} className={INP} /></Field>
            <Field label="Status"><select value={editing.status} onChange={(e) => setEditing((p) => ({ ...p, status: e.target.value }))} className={INP}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Paid Date"><input type="date" value={editing.paid_date || ""} onChange={(e) => setEditing((p) => ({ ...p, paid_date: e.target.value }))} className={INP} /></Field>
          </div>
          <Field label="Notes"><textarea value={editing.notes || ""} onChange={(e) => setEditing((p) => ({ ...p, notes: e.target.value }))} rows={2} className={`${INP} resize-none`} /></Field>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs">Calculated Amount: <span className="font-bold">{formatCurrency(preview)}</span></div>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
          <button onClick={onSave} disabled={saving} className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

export default function CommissionSection({ deal, commissions, ctx, canEdit, canApprove, canDelete, onChange, logActivity, user }) {
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const visible = user?.role === "sales_rep"
    ? commissions.filter((c) => c.recipient_user_id === user.id)
    : commissions;

  const active = visible.filter((c) => c.status !== "Cancelled");
  const totalCalculated = round2(active.reduce((s, c) => s + commissionAmount(c, ctx), 0));
  const totalPaid = round2(active.reduce((s, c) => s + safeNumber(c.paid_amount), 0));
  const balance = round2(totalCalculated - totalPaid);

  const openAdd = () =>
    setEditing({ recipient_name: "", recipient_user_id: "", commission_type: "percentage", commission_percentage: "", commission_fixed_amount: "", calculation_base: "total_contract", custom_base_amount: "", paid_amount: "", status: "Estimated", paid_date: "", notes: "" });
  const openEdit = (c) => setEditing({ ...c });

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        deal_id: deal.id,
        lead_id: deal.lead_id,
        recipient_name: editing.recipient_name || "",
        recipient_user_id: editing.recipient_user_id || null,
        commission_type: editing.commission_type,
        commission_percentage: editing.commission_type === "percentage" ? parseFloat(editing.commission_percentage) || 0 : 0,
        commission_fixed_amount: editing.commission_type === "fixed" ? parseFloat(editing.commission_fixed_amount) || 0 : 0,
        calculation_base: editing.calculation_base,
        custom_base_amount: parseFloat(editing.custom_base_amount) || 0,
        paid_amount: parseFloat(editing.paid_amount) || 0,
        status: editing.status,
        paid_date: editing.paid_date || null,
        notes: editing.notes || null,
        updated_by: user?.email || null,
      };
      if (editing.id) {
        await railwayDealCommissions.update(editing.id, payload);
        await logActivity("commission_edited", "DealCommission", `Commission edited for ${editing.recipient_name}`);
      } else {
        payload.created_by = user?.email || null;
        await railwayDealCommissions.create(payload);
        await logActivity("commission_added", "DealCommission", `Commission added for ${editing.recipient_name}`);
      }
      setEditing(null);
      onChange();
    } catch (e) {
      alert("Failed to save commission: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const approve = async (c) => {
    await railwayDealCommissions.update(c.id, { status: "Approved", updated_by: user?.email });
    await logActivity("commission_approved", "DealCommission", `Commission approved for ${c.recipient_name}`);
    onChange();
  };
  const markPaid = async (c) => {
    const amt = commissionAmount(c, ctx);
    await railwayDealCommissions.update(c.id, { status: "Paid", paid_amount: amt, paid_date: new Date().toISOString().slice(0, 10), updated_by: user?.email });
    await logActivity("commission_paid", "DealCommission", `Commission marked paid for ${c.recipient_name}`);
    onChange();
  };
  const del = async (c) => {
    if (!window.confirm("Delete this commission record?")) return;
    await railwayDealCommissions.remove(c.id);
    await logActivity("commission_deleted", "DealCommission", `Commission deleted for ${c.recipient_name}`);
    onChange();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="typography-section-header">SALES COMMISSION</p>
        {canEdit && (
          <button onClick={openAdd} className="sidebar-action-btn"><Plus className="w-3.5 h-3.5" /> Add Commission</button>
        )}
      </div>
      <div className="card-premium p-4 space-y-3">
        {visible.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-3">No commission records.</p>
        ) : (
          <div className="space-y-2">
            {visible.map((c) => {
              const amt = commissionAmount(c, ctx);
              return (
                <div key={c.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{c.recipient_name || "—"}</p>
                      <p className="text-[11px] text-slate-500">
                        {c.commission_type === "percentage" ? `${c.commission_percentage}%` : formatCurrency(c.commission_fixed_amount)} · {BASES.find((b) => b.value === c.calculation_base)?.label || c.calculation_base}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-sm font-bold text-slate-800">{formatCurrency(amt)}</span>
                      <StatusBadge status={c.status} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[11px] text-slate-500">Paid: {formatCurrency(c.paid_amount || 0)} · Balance: {formatCurrency(amt - safeNumber(c.paid_amount))}</span>
                    {canEdit && (
                      <div className="flex items-center gap-1.5">
                        {canApprove && c.status === "Estimated" && <button onClick={() => approve(c)} className="text-[11px] font-semibold text-emerald-600 hover:bg-emerald-50 px-1.5 py-0.5 rounded">Approve</button>}
                        {canApprove && c.status !== "Paid" && c.status !== "Cancelled" && <button onClick={() => markPaid(c)} className="text-[11px] font-semibold text-blue-600 hover:bg-blue-50 px-1.5 py-0.5 rounded">Mark Paid</button>}
                        <button onClick={() => openEdit(c)} className="text-[11px] font-semibold text-amber-600 hover:bg-amber-50 px-1.5 py-0.5 rounded">Edit</button>
                        {canDelete && <button onClick={() => del(c)} className="text-[11px] font-semibold text-rose-600 hover:bg-rose-50 px-1.5 py-0.5 rounded">Delete</button>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
          <Totals label="Total Calculated" value={formatCurrency(totalCalculated)} />
          <Totals label="Total Paid" value={formatCurrency(totalPaid)} />
          <Totals label="Balance" value={formatCurrency(balance)} />
        </div>
      </div>
      {editing && (
        <CommissionModal editing={editing} setEditing={setEditing} ctx={ctx} saving={saving} onSave={save} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}