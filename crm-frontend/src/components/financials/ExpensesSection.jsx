import { useState, useMemo } from "react";
import * as railwayDealExpenses from "@/api/railway/dealExpenses";
import * as railwayDealExpensePayments from "@/api/railway/dealExpensePayments";
import { formatCurrency, formatDate, safeNumber, round2 } from "@/lib/financialCalc";
import { Plus } from "lucide-react";
import ReceiptUpload from "./ReceiptUpload";
import { deleteFileFromStorage, extractKey } from "@/lib/fileUpload";

const CATEGORIES = ["Materials","Labor","Subcontractor","Permit","Engineering","Architect","Design","Inspection","Dumpster","Equipment Rental","Delivery","Roofing","Solar","Pool","Landscaping","Plumbing","Electrical","HVAC","Insurance","Marketing","Lead Cost","Financing Fee","Loan Interest","General Overhead","Other"];
const PAY_STATUSES = ["Unpaid","Partially Paid","Paid","Refunded","Cancelled"];
const PAY_METHODS = ["ACH","Check","Credit Card","Debit Card","Cash","Zelle","Wire","QuickBooks","Other"];
const INP = "w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm";

function StatusPill({ status }) {
  const map = { Unpaid: "bg-slate-100 text-slate-600", "Partially Paid": "bg-amber-100 text-amber-700", Paid: "bg-emerald-100 text-emerald-700", Refunded: "bg-blue-100 text-blue-700", Cancelled: "bg-rose-100 text-rose-700" };
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${map[status] || "bg-slate-100 text-slate-600"}`}>{status}</span>;
}
function Field({ label, children }) {
  return (<div><label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">{label}</label>{children}</div>);
}

function ExpenseModal({ editing, setEditing, saving, onSave, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800">{editing.id ? "Edit Expense" : "Add Expense"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Expense Date"><input type="date" value={editing.expense_date || ""} onChange={(e) => setEditing((p) => ({ ...p, expense_date: e.target.value }))} className={INP} /></Field>
            <Field label="Vendor Name"><input value={editing.vendor_name || ""} onChange={(e) => setEditing((p) => ({ ...p, vendor_name: e.target.value }))} className={INP} /></Field>
            <Field label="Category"><select value={editing.category} onChange={(e) => setEditing((p) => ({ ...p, category: e.target.value }))} className={INP}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="Amount ($)"><input type="number" step="0.01" value={editing.amount || ""} onChange={(e) => setEditing((p) => ({ ...p, amount: e.target.value }))} className={INP} /></Field>
            <Field label="Payment Status"><select value={editing.payment_status} onChange={(e) => setEditing((p) => ({ ...p, payment_status: e.target.value }))} className={INP}>{PAY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Payment Method"><select value={editing.payment_method || ""} onChange={(e) => setEditing((p) => ({ ...p, payment_method: e.target.value }))} className={INP}><option value="">—</option>{PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
            <Field label="Check / Reference #"><input value={editing.check_or_reference_number || ""} onChange={(e) => setEditing((p) => ({ ...p, check_or_reference_number: e.target.value }))} className={INP} /></Field>
          </div>
          <Field label="Description"><textarea value={editing.description || ""} onChange={(e) => setEditing((p) => ({ ...p, description: e.target.value }))} rows={2} className={`${INP} resize-none`} /></Field>
          <Field label="Notes"><textarea value={editing.notes || ""} onChange={(e) => setEditing((p) => ({ ...p, notes: e.target.value }))} rows={2} className={`${INP} resize-none`} /></Field>
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={editing.include_in_profit_calculation !== false} onChange={(e) => setEditing((p) => ({ ...p, include_in_profit_calculation: e.target.checked }))} /> Include in profit calculation</label>
          <Field label="Receipt"><ReceiptUpload value={editing.receipt_url} filename={editing.receipt_filename} fileKey={editing.receipt_key} onChange={(r) => setEditing((p) => ({ ...p, receipt_url: r.url, receipt_key: r.key, receipt_filename: r.filename, receipt_mime_type: r.mime }))} onRemove={() => setEditing((p) => ({ ...p, receipt_url: null, receipt_key: null, receipt_filename: null, receipt_mime_type: null }))} /></Field>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
          <button onClick={onSave} disabled={saving} className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function PaymentsModal({ expense, payments, deal, user, onClose, onChange, logActivity, canEdit }) {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ payment_date: new Date().toISOString().slice(0, 10), amount: "", payment_method: "Check", reference_number: "", notes: "", receipt_url: "", receipt_key: "", receipt_filename: "" });

  const paid = round2(payments.reduce((s, p) => s + safeNumber(p.amount), 0));
  const remaining = round2(safeNumber(expense.amount) - paid);
  const wouldExceed = safeNumber(form.amount) > remaining + 0.01;

  const addPayment = async () => {
    if (!form.amount) { alert("Enter amount"); return; }
    if (wouldExceed && !window.confirm("Total payments will exceed the expense amount. Continue anyway?")) return;
    setSaving(true);
    try {
      const payload = {
        deal_id: deal.id, expense_id: expense.id,
        payment_date: form.payment_date || null,
        amount: parseFloat(form.amount) || 0,
        payment_method: form.payment_method || null,
        reference_number: form.reference_number || null,
        receipt_url: form.receipt_url || null, receipt_filename: form.receipt_filename || null, receipt_key: form.receipt_key || null,
        notes: form.notes || null, created_by: user?.email || null,
      };
      await railwayDealExpensePayments.create(payload);
      const newPaid = round2(paid + safeNumber(form.amount));
      const expAmt = safeNumber(expense.amount);
      let status = "Unpaid";
      if (newPaid <= 0) status = "Unpaid";
      else if (newPaid < expAmt) status = "Partially Paid";
      else status = "Paid";
      await railwayDealExpenses.update(expense.id, { amount_paid: newPaid, amount_remaining: round2(Math.max(0, expAmt - newPaid)), payment_status: status, updated_by: user?.email });
      await logActivity("expense_payment_added", "DealExpensePayment", `Payment added for ${expense.vendor_name}: ${formatCurrency(payload.amount)}`);
      setAdding(false);
      setForm({ payment_date: new Date().toISOString().slice(0, 10), amount: "", payment_method: "Check", reference_number: "", notes: "", receipt_url: "", receipt_key: "", receipt_filename: "" });
      onChange();
    } catch (e) {
      alert("Failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const delPayment = async (p) => {
    if (!window.confirm("Delete this payment?")) return;
    const _receiptKey = p.receipt_key || extractKey(p.receipt_url);
    if (_receiptKey) { try { await deleteFileFromStorage(_receiptKey); } catch (_err) { /* proceed with record delete */ } }
    await railwayDealExpensePayments.remove(p.id);
    onChange();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800">Payments — {expense.vendor_name}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-slate-600 flex justify-between gap-2">
            <span>Expense: <b>{formatCurrency(expense.amount)}</b></span>
            <span>Paid: <b>{formatCurrency(paid)}</b></span>
            <span>Remaining: <b>{formatCurrency(remaining)}</b></span>
          </div>
          {payments.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-2">No payments yet.</p>
          ) : (
            <div className="space-y-1.5">
              {payments.map((p) => (
                <div key={p.id} className="flex justify-between items-center border border-slate-100 rounded-lg px-2.5 py-1.5 text-xs">
                  <div><span className="font-medium">{formatDate(p.payment_date)}</span> · {formatCurrency(p.amount)} · {p.payment_method || "—"} {p.reference_number ? `· ${p.reference_number}` : ""}</div>
                  {canEdit && <button onClick={() => delPayment(p)} className="text-rose-600 font-semibold">Delete</button>}
                </div>
              ))}
            </div>
          )}
          {canEdit && (
            <div className="border-t border-slate-100 pt-3 space-y-2">
              {!adding ? (
                <button onClick={() => setAdding(true)} className="sidebar-action-btn"><Plus className="w-3.5 h-3.5" /> Add Payment</button>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Payment Date"><input type="date" value={form.payment_date} onChange={(e) => setForm((p) => ({ ...p, payment_date: e.target.value }))} className={INP} /></Field>
                    <Field label="Amount ($)"><input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} className={INP} /></Field>
                    <Field label="Method"><select value={form.payment_method} onChange={(e) => setForm((p) => ({ ...p, payment_method: e.target.value }))} className={INP}>{PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
                    <Field label="Reference #"><input value={form.reference_number} onChange={(e) => setForm((p) => ({ ...p, reference_number: e.target.value }))} className={INP} /></Field>
                  </div>
                  <Field label="Receipt"><ReceiptUpload value={form.receipt_url} filename={form.receipt_filename} fileKey={form.receipt_key} onChange={(r) => setForm((p) => ({ ...p, receipt_url: r.url, receipt_key: r.key, receipt_filename: r.filename }))} onRemove={() => setForm((p) => ({ ...p, receipt_url: null, receipt_key: null, receipt_filename: null }))} /></Field>
                  {wouldExceed && <p className="text-[11px] text-amber-700 font-semibold">⚠ Total payments exceed expense amount.</p>}
                  <div className="flex gap-2">
                    <button onClick={addPayment} disabled={saving} className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg disabled:opacity-50">{saving ? "Saving…" : "Save Payment"}</button>
                    <button onClick={() => setAdding(false)} className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExpensesSection({ deal, expenses, payments, canEdit, canDelete, onChange, logActivity, user }) {
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPaymentsFor, setShowPaymentsFor] = useState(null);
  const [filters, setFilters] = useState({ search: "", category: "", vendor: "", payment_status: "", from: "", to: "" });

  const vendors = useMemo(() => Array.from(new Set(expenses.map((e) => e.vendor_name).filter(Boolean))), [expenses]);

  const filtered = useMemo(() => {
    return expenses.filter((e) => {
      if (filters.search && !`${e.vendor_name || ""} ${e.description || ""}`.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.category && e.category !== filters.category) return false;
      if (filters.vendor && e.vendor_name !== filters.vendor) return false;
      if (filters.payment_status && e.payment_status !== filters.payment_status) return false;
      if (filters.from && e.expense_date && e.expense_date < filters.from) return false;
      if (filters.to && e.expense_date && e.expense_date > filters.to) return false;
      return true;
    }).sort((a, b) => (b.expense_date || "").localeCompare(a.expense_date || ""));
  }, [expenses, filters]);

  const filteredTotal = round2(
    filtered.filter((e) => e.payment_status !== "Cancelled" && e.payment_status !== "Refunded").reduce((s, e) => s + safeNumber(e.amount), 0)
    - filtered.filter((e) => e.payment_status === "Refunded").reduce((s, e) => s + safeNumber(e.amount), 0)
  );

  const openAdd = () => setEditing({ expense_date: new Date().toISOString().slice(0, 10), vendor_name: "", category: "Materials", description: "", amount: "", payment_status: "Unpaid", payment_method: "Check", check_or_reference_number: "", notes: "", include_in_profit_calculation: true, receipt_url: "", receipt_filename: "", receipt_mime_type: "" });
  const openEdit = (e) => setEditing({ ...e, _orig_receipt_key: e.receipt_key || null });

  const save = async () => {
    if (!editing) return;
    if (!editing.vendor_name || !editing.amount) { alert("Vendor and amount are required"); return; }
    const dup = expenses.find((e) => (!editing.id || e.id !== editing.id) && e.vendor_name === editing.vendor_name && safeNumber(e.amount) === safeNumber(editing.amount) && e.expense_date === editing.expense_date);
    if (dup && !window.confirm("A matching expense (same vendor, amount, and date) already exists. Save anyway?")) return;
    setSaving(true);
    try {
      const payload = {
        deal_id: deal.id, lead_id: deal.lead_id,
        expense_date: editing.expense_date || null,
        vendor_name: editing.vendor_name,
        category: editing.category || "Other",
        description: editing.description || null,
        amount: parseFloat(editing.amount) || 0,
        payment_status: editing.payment_status || "Unpaid",
        payment_method: editing.payment_method || null,
        check_or_reference_number: editing.check_or_reference_number || null,
        notes: editing.notes || null,
        include_in_profit_calculation: editing.include_in_profit_calculation !== false,
        receipt_url: editing.receipt_url || null,
        receipt_key: editing.receipt_key || null,
        receipt_filename: editing.receipt_filename || null,
        receipt_mime_type: editing.receipt_mime_type || null,
        updated_by: user?.email || null,
      };
      if (editing.id) {
        await railwayDealExpenses.update(editing.id, payload);
        // Replace cleanup: delete the previous R2 object only after the new key is saved.
        const _oldKey = editing._orig_receipt_key;
        if (_oldKey && _oldKey !== payload.receipt_key) {
          try { await deleteFileFromStorage(_oldKey); }
          catch (clErr) { console.warn("[expense] old receipt cleanup failed:", clErr.message); }
        }
        await logActivity("expense_edited", "DealExpense", `Expense edited: ${editing.vendor_name} (${formatCurrency(payload.amount)})`, { record_id: editing.id });
      } else {
        payload.created_by = user?.email || null;
        const created = await railwayDealExpenses.create(payload);
        await logActivity("expense_added", "DealExpense", `Expense added: ${editing.vendor_name} (${formatCurrency(payload.amount)})`, { record_id: created?.id });
      }
      setEditing(null);
      onChange();
    } catch (e) {
      alert("Failed to save expense: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (e) => {
    if (!window.confirm(`Delete expense for ${e.vendor_name}?`)) return;
    // ── TEMPORARY TRACE: Expense delete path (remove after diagnosis) ──
    const _extracted = extractKey(e.receipt_url);
    const _receiptKey = e.receipt_key || _extracted;
    console.log("[EXPENSE-DELETE-TRACE] step=start", {
      expenseId: e.id, vendor: e.vendor_name,
      receipt_url: e.receipt_url,
      receipt_key: e.receipt_key,
      extractedFromUrl: _extracted,
      keyPassedToDeleteFn: _receiptKey,
      willCallDeleteFile: !!_receiptKey,
    });
    if (_receiptKey) {
      console.log("[EXPENSE-DELETE-TRACE] step=beforeDeleteFile recordStillExists=true");
      try {
        await deleteFileFromStorage(_receiptKey);
        console.log("[EXPENSE-DELETE-TRACE] step=deleteFileResolved success=true recordStillExists=true");
      } catch (_err) {
        console.log("[EXPENSE-DELETE-TRACE] step=deleteFileCaught error=", _err?.message || String(_err), "proceedingWithRecordDelete=true recordStillExists=true");
      }
      console.log("[EXPENSE-DELETE-TRACE] step=afterDeleteFile r2DeletePromiseResolved=true aboutToCallRecordDelete=true");
    } else {
      console.log("[EXPENSE-DELETE-TRACE] step=skipDelete reason=noKey receipt_url=", e.receipt_url, "receipt_key=", e.receipt_key);
    }
    console.log("[EXPENSE-DELETE-TRACE] step=beforeRecordDelete order=", _receiptKey ? "r2_first_then_record" : "record_only");
    await railwayDealExpenses.remove(e.id);
    console.log("[EXPENSE-DELETE-TRACE] step=afterRecordDelete recordDeleted=true");
    // Cascade delete expense payments (Railway API has no removeMany)
    try {
      const epRes = await railwayDealExpensePayments.list({ expense_id: e.id });
      await Promise.all((epRes.items || []).map(p => railwayDealExpensePayments.remove(p.id)));
    } catch {}
    await logActivity("expense_deleted", "DealExpense", `Expense deleted: ${e.vendor_name} (${formatCurrency(e.amount)})`);
    onChange();
    console.log("[EXPENSE-DELETE-TRACE] step=done");
    // ── END TEMPORARY TRACE ──
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="typography-section-header">VENDOR & PROJECT EXPENSES</p>
        {canEdit && <button onClick={openAdd} className="sidebar-action-btn"><Plus className="w-3.5 h-3.5" /> Add Expense</button>}
      </div>
      <div className="card-premium p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <input placeholder="Search…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs"><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <select value={filters.vendor} onChange={(e) => setFilters((f) => ({ ...f, vendor: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs"><option value="">All vendors</option>{vendors.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <select value={filters.payment_status} onChange={(e) => setFilters((f) => ({ ...f, payment_status: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs"><option value="">All statuses</option>{PAY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
          <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
        </div>

        {filtered.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-4">No expenses found.</p>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="py-2 pr-2 font-semibold">Date</th>
                    <th className="pr-2 font-semibold">Vendor</th>
                    <th className="pr-2 font-semibold">Category</th>
                    <th className="pr-2 font-semibold">Description</th>
                    <th className="pr-2 font-semibold text-right">Amount</th>
                    <th className="pr-2 font-semibold">Status</th>
                    <th className="pr-2 font-semibold">Receipt</th>
                    <th className="pr-2 font-semibold">Created By</th>
                    <th className="font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} className="border-b border-slate-50">
                      <td className="py-2 pr-2 text-slate-600">{formatDate(e.expense_date)}</td>
                      <td className="pr-2 font-medium text-slate-800">{e.vendor_name}</td>
                      <td className="pr-2 text-slate-600">{e.category}</td>
                      <td className="pr-2 text-slate-600 max-w-[160px] truncate">{e.description || "—"}</td>
                      <td className="pr-2 text-right font-semibold text-slate-800">{formatCurrency(e.amount)}</td>
                      <td className="pr-2"><StatusPill status={e.payment_status} /></td>
                      <td className="pr-2">{e.receipt_url ? <a href={e.receipt_url} target="_blank" rel="noopener noreferrer" className="text-amber-600 font-semibold">View</a> : <span className="text-slate-300">—</span>}</td>
                      <td className="pr-2 text-slate-500">{e.created_by?.split("@")[0] || "—"}</td>
                      <td className="whitespace-nowrap">
                        {canEdit && <button onClick={() => openEdit(e)} className="text-amber-600 font-semibold hover:underline mr-2">Edit</button>}
                        {canEdit && <button onClick={() => setShowPaymentsFor(e)} className="text-blue-600 font-semibold hover:underline mr-2">Payments</button>}
                        {canDelete && <button onClick={() => del(e)} className="text-rose-600 font-semibold hover:underline">Delete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-2">
              {filtered.map((e) => (
                <div key={e.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex justify-between"><span className="font-semibold text-slate-800 text-sm">{e.vendor_name}</span><span className="font-bold text-sm">{formatCurrency(e.amount)}</span></div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{formatDate(e.expense_date)} · {e.category} · <StatusPill status={e.payment_status} /></div>
                  {e.description && <p className="text-xs text-slate-600 mt-1">{e.description}</p>}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {canEdit && <button onClick={() => openEdit(e)} className="text-[11px] font-semibold text-amber-600">Edit</button>}
                    {canEdit && <button onClick={() => setShowPaymentsFor(e)} className="text-[11px] font-semibold text-blue-600">Payments</button>}
                    {e.receipt_url && <a href={e.receipt_url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-semibold text-amber-600">View Receipt</a>}
                    {canDelete && <button onClick={() => del(e)} className="text-[11px] font-semibold text-rose-600">Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="flex justify-between items-center pt-2 border-t border-slate-100">
          <span className="text-[11px] text-slate-500">Filtered total ({filtered.length})</span>
          <span className="text-sm font-bold text-slate-800">{formatCurrency(filteredTotal)}</span>
        </div>
      </div>

      {editing && <ExpenseModal editing={editing} setEditing={setEditing} saving={saving} onSave={save} onClose={() => setEditing(null)} />}
      {showPaymentsFor && (
        <PaymentsModal
          expense={showPaymentsFor}
          payments={payments.filter((p) => p.expense_id === showPaymentsFor.id)}
          deal={deal} user={user} canEdit={canEdit}
          onClose={() => setShowPaymentsFor(null)}
          onChange={onChange} logActivity={logActivity}
        />
      )}
    </div>
  );
}