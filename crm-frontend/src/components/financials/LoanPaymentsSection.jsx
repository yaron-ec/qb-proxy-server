import { useState } from "react";
import * as railwayDealLoanPayments from "@/api/railway/dealLoanPayments";
import { formatCurrency, formatDate, safeNumber, round2 } from "@/lib/financialCalc";
import { Plus } from "lucide-react";
import ReceiptUpload from "./ReceiptUpload";
import { deleteFileFromStorage, extractKey } from "@/lib/fileUpload";

const INP = "w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm";

function FT({ label, value, tone }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className={`text-sm font-bold ${tone === "neg" ? "text-rose-700" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}
function F({ label, children }) {
  return (<div><label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">{label}</label>{children}</div>);
}

function LoanModal({ editing, setEditing, saving, onSave, onClose }) {
  const total = safeNumber(editing.total_payment_amount);
  const sum = safeNumber(editing.principal_amount) + safeNumber(editing.interest_amount) + safeNumber(editing.fee_amount) + safeNumber(editing.other_cost_amount);
  const diff = round2(total - sum);
  const valid = Math.abs(diff) <= 0.01;
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800">{editing.id ? "Edit Loan Payment" : "Add Loan Payment"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <F label="Payment Date"><input type="date" value={editing.payment_date || ""} onChange={(e) => setEditing((p) => ({ ...p, payment_date: e.target.value }))} className={INP} /></F>
            <F label="Lender Name"><input value={editing.lender_name || ""} onChange={(e) => setEditing((p) => ({ ...p, lender_name: e.target.value }))} className={INP} /></F>
            <F label="Loan Account Name"><input value={editing.loan_account_name || ""} onChange={(e) => setEditing((p) => ({ ...p, loan_account_name: e.target.value }))} className={INP} /></F>
            <F label="Reference #"><input value={editing.reference_number || ""} onChange={(e) => setEditing((p) => ({ ...p, reference_number: e.target.value }))} className={INP} /></F>
            <F label="Total Payment ($)"><input type="number" step="0.01" value={editing.total_payment_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, total_payment_amount: e.target.value }))} className={INP} /></F>
            <F label="Principal ($)"><input type="number" step="0.01" value={editing.principal_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, principal_amount: e.target.value }))} className={INP} /></F>
            <F label="Interest ($)"><input type="number" step="0.01" value={editing.interest_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, interest_amount: e.target.value }))} className={INP} /></F>
            <F label="Fees ($)"><input type="number" step="0.01" value={editing.fee_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, fee_amount: e.target.value }))} className={INP} /></F>
            <F label="Other Cost ($)"><input type="number" step="0.01" value={editing.other_cost_amount || ""} onChange={(e) => setEditing((p) => ({ ...p, other_cost_amount: e.target.value }))} className={INP} /></F>
          </div>
          <F label="Notes"><textarea value={editing.notes || ""} onChange={(e) => setEditing((p) => ({ ...p, notes: e.target.value }))} rows={2} className={`${INP} resize-none`} /></F>
          <F label="Receipt"><ReceiptUpload value={editing.receipt_url} filename={editing.receipt_filename} fileKey={editing.receipt_key} onChange={(r) => setEditing((p) => ({ ...p, receipt_url: r.url, receipt_key: r.key, receipt_filename: r.filename }))} onRemove={() => setEditing((p) => ({ ...p, receipt_url: null, receipt_key: null, receipt_filename: null }))} /></F>
          <div className={`text-xs rounded-lg px-2.5 py-2 border ${valid ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-rose-50 border-rose-200 text-rose-700"}`}>
            Split sum: {formatCurrency(sum)} · Difference: {formatCurrency(diff)} {valid ? "✓" : "— must equal total within $0.01"}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
          <button onClick={onSave} disabled={saving || !valid} className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

export default function LoanPaymentsSection({ deal, loanPayments, canEdit, canDelete, onChange, logActivity, user }) {
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const totals = loanPayments.reduce((acc, lp) => ({
    total: acc.total + safeNumber(lp.total_payment_amount),
    principal: acc.principal + safeNumber(lp.principal_amount),
    interest: acc.interest + safeNumber(lp.interest_amount),
    fees: acc.fees + safeNumber(lp.fee_amount),
    finCost: acc.finCost + safeNumber(lp.interest_amount) + safeNumber(lp.fee_amount) + safeNumber(lp.other_cost_amount),
  }), { total: 0, principal: 0, interest: 0, fees: 0, finCost: 0 });

  const openAdd = () => setEditing({ payment_date: new Date().toISOString().slice(0, 10), lender_name: "", loan_account_name: "", total_payment_amount: "", principal_amount: "", interest_amount: "", fee_amount: "", other_cost_amount: "", reference_number: "", notes: "", receipt_url: "", receipt_key: "", receipt_filename: "" });
  const openEdit = (lp) => setEditing({ ...lp, _orig_receipt_key: lp.receipt_key || null });

  const save = async () => {
    if (!editing) return;
    const total = round2(safeNumber(editing.total_payment_amount));
    const sum = round2(safeNumber(editing.principal_amount) + safeNumber(editing.interest_amount) + safeNumber(editing.fee_amount) + safeNumber(editing.other_cost_amount));
    if (Math.abs(total - sum) > 0.01) {
      alert(`Split (${formatCurrency(sum)}) must equal total payment (${formatCurrency(total)}). Difference exceeds $0.01.`);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        deal_id: deal.id, lead_id: deal.lead_id,
        payment_date: editing.payment_date || null,
        lender_name: editing.lender_name || null,
        loan_account_name: editing.loan_account_name || null,
        total_payment_amount: parseFloat(editing.total_payment_amount) || 0,
        principal_amount: parseFloat(editing.principal_amount) || 0,
        interest_amount: parseFloat(editing.interest_amount) || 0,
        fee_amount: parseFloat(editing.fee_amount) || 0,
        other_cost_amount: parseFloat(editing.other_cost_amount) || 0,
        reference_number: editing.reference_number || null,
        receipt_url: editing.receipt_url || null,
        receipt_key: editing.receipt_key || null,
        receipt_filename: editing.receipt_filename || null,
        notes: editing.notes || null,
        updated_by: user?.email || null,
      };
      if (editing.id) {
        await railwayDealLoanPayments.update(editing.id, payload);
        // Replace cleanup: delete the previous R2 object only after the new key is saved.
        const _oldKey = editing._orig_receipt_key;
        if (_oldKey && _oldKey !== payload.receipt_key) {
          try { await deleteFileFromStorage(_oldKey); }
          catch (clErr) { console.warn("[loan] old receipt cleanup failed:", clErr.message); }
        }
        await logActivity("loan_payment_edited", "DealLoanPayment", `Loan payment edited: ${editing.lender_name || "—"}`);
      } else {
        payload.created_by = user?.email || null;
        const created = await railwayDealLoanPayments.create(payload);
        await logActivity("loan_payment_added", "DealLoanPayment", `Loan payment added: ${editing.lender_name || "—"} (${formatCurrency(payload.total_payment_amount)})`, { record_id: created?.id });
      }
      setEditing(null);
      onChange();
    } catch (e) {
      alert("Failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (lp) => {
    if (!window.confirm("Delete this loan payment?")) return;
    const _receiptKey = lp.receipt_key || extractKey(lp.receipt_url);
    if (_receiptKey) { try { await deleteFileFromStorage(_receiptKey); } catch (_err) { /* proceed with record delete */ } }
    await railwayDealLoanPayments.remove(lp.id);
    await logActivity("loan_payment_deleted", "DealLoanPayment", `Loan payment deleted`);
    onChange();
  };

  const sorted = [...loanPayments].sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || ""));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="typography-section-header">LOAN PAYMENTS</p>
        {canEdit && <button onClick={openAdd} className="sidebar-action-btn"><Plus className="w-3.5 h-3.5" /> Add Loan Payment</button>}
      </div>
      <div className="card-premium p-4 space-y-3">
        {sorted.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-3">No loan payments.</p>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="py-2 pr-2 font-semibold">Date</th>
                    <th className="pr-2 font-semibold">Lender</th>
                    <th className="pr-2 font-semibold text-right">Total</th>
                    <th className="pr-2 font-semibold text-right">Principal</th>
                    <th className="pr-2 font-semibold text-right">Interest</th>
                    <th className="pr-2 font-semibold text-right">Fees</th>
                    <th className="pr-2 font-semibold">Receipt</th>
                    <th className="font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((lp) => (
                    <tr key={lp.id} className="border-b border-slate-50">
                      <td className="py-2 pr-2 text-slate-600">{formatDate(lp.payment_date)}</td>
                      <td className="pr-2 font-medium text-slate-800">{lp.lender_name || "—"}</td>
                      <td className="pr-2 text-right font-semibold">{formatCurrency(lp.total_payment_amount)}</td>
                      <td className="pr-2 text-right text-slate-600">{formatCurrency(lp.principal_amount)}</td>
                      <td className="pr-2 text-right text-slate-600">{formatCurrency(lp.interest_amount)}</td>
                      <td className="pr-2 text-right text-slate-600">{formatCurrency(lp.fee_amount)}</td>
                      <td className="pr-2">{lp.receipt_url ? <a href={lp.receipt_url} target="_blank" rel="noopener noreferrer" className="text-amber-600 font-semibold">View</a> : <span className="text-slate-300">—</span>}</td>
                      <td className="whitespace-nowrap">
                        {canEdit && <button onClick={() => openEdit(lp)} className="text-amber-600 font-semibold hover:underline mr-2">Edit</button>}
                        {canDelete && <button onClick={() => del(lp)} className="text-rose-600 font-semibold hover:underline">Delete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-2">
              {sorted.map((lp) => (
                <div key={lp.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex justify-between"><span className="font-semibold text-sm">{lp.lender_name || "—"}</span><span className="font-bold text-sm">{formatCurrency(lp.total_payment_amount)}</span></div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{formatDate(lp.payment_date)} · Principal {formatCurrency(lp.principal_amount)} · Interest {formatCurrency(lp.interest_amount)} · Fees {formatCurrency(lp.fee_amount)}</div>
                  <div className="flex gap-2 mt-2">
                    {canEdit && <button onClick={() => openEdit(lp)} className="text-[11px] font-semibold text-amber-600">Edit</button>}
                    {canDelete && <button onClick={() => del(lp)} className="text-[11px] font-semibold text-rose-600">Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-slate-100">
          <FT label="Total Loan Payments" value={formatCurrency(totals.total)} />
          <FT label="Total Principal" value={formatCurrency(totals.principal)} />
          <FT label="Total Interest" value={formatCurrency(totals.interest)} />
          <FT label="Total Fees" value={formatCurrency(totals.fees)} />
          <FT label="Financing Cost → Profit" value={formatCurrency(totals.finCost)} tone="neg" />
        </div>
      </div>
      {editing && <LoanModal editing={editing} setEditing={setEditing} saving={saving} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}