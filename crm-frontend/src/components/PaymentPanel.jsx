import { useState, useEffect } from "react";
import { leads as railwayLeads } from "@/api/railway";
import { ChevronDown, ChevronRight, Save, X, AlertCircle, Check } from "lucide-react";

const fmt = (iso) => iso
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "—";

const fmtMoney = (v) => v != null
  ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : "$0.00";

export default function PaymentPanel({ lead, onLeadUpdate }) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const [form, setForm] = useState({
    qb_invoice_amount: lead.qb_invoice_amount || 0,
    qb_deposit_amount: lead.qb_deposit_amount || 0,
    qb_payment_received: lead.qb_payment_received || 0,
    qb_payment_method: lead.qb_payment_method || "Check",
    qb_payment_date: lead.qb_payment_date || "",
    qb_payment_notes: lead.qb_payment_notes || "",
  });

  // Calculate balance due
  const invoiceAmount = form.qb_invoice_amount || 0;
  const depositAmount = form.qb_deposit_amount || 0;
  const paymentReceived = form.qb_payment_received || 0;
  const balanceDue = invoiceAmount - depositAmount - paymentReceived;

  // Determine payment status
  const getPaymentStatus = () => {
    if (balanceDue <= 0) return "paid";
    if (paymentReceived > 0 || depositAmount > 0) return "partial";
    return "unpaid";
  };

  const paymentStatus = getPaymentStatus();
  const statusColor = {
    paid: "text-emerald-600",
    partial: "text-amber-600",
    unpaid: "text-red-500",
  };

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      const updated = await railwayLeads.update(lead.id, {
        ...form,
        qb_balance_due: balanceDue,
        qb_payment_status: paymentStatus,
        qb_last_sync_at: new Date().toISOString(),
        qb_last_sync_result: "success",
        qb_last_error: null,
      });
      setToast({ ok: true, msg: "Payment info saved" });
      setEditing(false);
      onLeadUpdate?.(updated);
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setForm({
      qb_invoice_amount: lead.qb_invoice_amount || 0,
      qb_deposit_amount: lead.qb_deposit_amount || 0,
      qb_payment_received: lead.qb_payment_received || 0,
      qb_payment_method: lead.qb_payment_method || "Check",
      qb_payment_date: lead.qb_payment_date || "",
      qb_payment_notes: lead.qb_payment_notes || "",
    });
    setEditing(false);
  };

  return (
    <div className="border-t border-slate-100">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-3 h-3 text-orange" /> : <ChevronDown className="w-3 h-3 text-orange" />}
          <span className="text-xs font-bold text-slate-700">💰 Payment Info</span>
          {lead.qb_payment_status && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded capitalize ${
              lead.qb_payment_status === "paid" ? "bg-emerald-100 text-emerald-700"
              : lead.qb_payment_status === "partial" ? "bg-amber-100 text-amber-700"
              : "bg-red-100 text-red-600"
            }`}>
              {lead.qb_payment_status}
            </span>
          )}
        </div>
        {!editing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
              setCollapsed(false);
            }}
            className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 transition-colors"
          >
            Edit
          </button>
        )}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3">
          {/* Toast */}
          {toast && (
            <div className={`text-[10px] font-semibold px-2 py-1.5 rounded border flex items-center gap-1.5 ${
              toast.ok 
                ? "bg-emerald-50 border-emerald-200 text-emerald-700" 
                : "bg-red-50 border-red-200 text-red-600"
            }`}>
              {toast.ok ? <Check className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
              {toast.msg}
            </div>
          )}

          {editing ? (
            // Edit Form
            <div className="space-y-3 bg-slate-50 border border-slate-200 rounded p-3">
              {/* Invoice # - Read Only */}
              {lead.qb_invoice_id && (
                <div>
                  <label className="text-[9px] font-bold text-primary uppercase block mb-1">Invoice # (QB Generated)</label>
                  <div className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono text-primary bg-white font-bold">
                    {lead.qb_invoice_number || lead.qb_invoice_id}
                  </div>
                </div>
              )}

              <div>
                <label className="text-[9px] font-bold text-primary uppercase block mb-1">Invoice Amount</label>
                <input
                  type="number"
                  value={form.qb_invoice_amount}
                  onChange={(e) => setForm({ ...form, qb_invoice_amount: parseFloat(e.target.value) || 0 })}
                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange"
                  placeholder="0.00"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] font-bold text-primary uppercase block mb-1">Deposit</label>
                  <input
                    type="number"
                    value={form.qb_deposit_amount}
                    onChange={(e) => setForm({ ...form, qb_deposit_amount: parseFloat(e.target.value) || 0 })}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-primary uppercase block mb-1">Payment Received</label>
                  <input
                    type="number"
                    value={form.qb_payment_received}
                    onChange={(e) => setForm({ ...form, qb_payment_received: parseFloat(e.target.value) || 0 })}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange"
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] font-bold text-primary uppercase block mb-1">Payment Method</label>
                  <select
                    value={form.qb_payment_method}
                    onChange={(e) => setForm({ ...form, qb_payment_method: e.target.value })}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange bg-white"
                  >
                    <option value="Cash">Cash</option>
                    <option value="Check">Check</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="text-[9px] font-bold text-primary uppercase block mb-1">Payment Date</label>
                  <input
                    type="date"
                    value={form.qb_payment_date}
                    onChange={(e) => setForm({ ...form, qb_payment_date: e.target.value })}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange"
                  />
                </div>
              </div>

              <div>
                <label className="text-[9px] font-bold text-primary uppercase block mb-1">Notes</label>
                <textarea
                  value={form.qb_payment_notes}
                  onChange={(e) => setForm({ ...form, qb_payment_notes: e.target.value })}
                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-orange/50 focus:border-orange resize-none"
                  rows={2}
                  placeholder="Payment notes..."
                />
              </div>

              {/* Balance Due Preview */}
              <div className="bg-white border border-slate-200 rounded p-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Balance Due:</span>
                  <span className={`font-bold ${statusColor[paymentStatus]}`}>
                    {fmtMoney(balanceDue)}
                  </span>
                </div>
                <div className="text-[9px] text-slate-500 mt-1 space-y-0.5">
                  <div>Invoice: {fmtMoney(invoiceAmount)}</div>
                  <div>- Deposit: {fmtMoney(depositAmount)}</div>
                  <div>- Paid: {fmtMoney(paymentReceived)}</div>
                  <div className="border-t border-slate-200 pt-0.5 mt-0.5">= {capitalize(paymentStatus)}</div>
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={handleCancel}
                  disabled={saving}
                  className="flex-1 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !lead.qb_invoice_id}
                  title={!lead.qb_invoice_id ? "Create QuickBooks invoice first" : ""}
                  className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-orange hover:bg-orange/90 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                >
                  <Save className="w-3 h-3" />
                  {saving ? "Saving..." : "Save Payment"}
                </button>
              </div>
            </div>
          ) : (
            // Display View
            <div className="space-y-2">
              {lead.qb_invoice_id && (
                <PaymentRow label="Invoice # (QB)" value={lead.qb_invoice_number || lead.qb_invoice_id} />
              )}
              <PaymentRow label="Invoice Amount" value={fmtMoney(lead.qb_invoice_amount)} />
              <PaymentRow label="Deposit" value={fmtMoney(lead.qb_deposit_amount)} />
              <PaymentRow label="Payment Received" value={fmtMoney(lead.qb_payment_received)} />
              <PaymentRow label="Payment Method" value={lead.qb_payment_method || "—"} />
              <PaymentRow label="Payment Date" value={fmt(lead.qb_payment_date)} />

              <div className="border-t border-slate-100 pt-2 mt-2">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-bold text-slate-700">Balance Due</span>
                  <span className={`font-bold ${statusColor[lead.qb_payment_status] || "text-slate-700"}`}>
                    {fmtMoney(lead.qb_balance_due || 0)}
                  </span>
                </div>
              </div>

              {lead.qb_payment_notes && (
                <div className="text-[10px] text-slate-600 bg-slate-50 border border-slate-100 rounded p-2">
                  <span className="font-semibold">Notes:</span> {lead.qb_payment_notes}
                </div>
              )}

              {lead.qb_last_sync_at && (
                <div className="text-[9px] text-slate-400 mt-2">
                  Last synced: {fmt(lead.qb_last_sync_at)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentRow({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{label}</span>
      <span className="text-[11px] text-slate-700 font-semibold">{value}</span>
    </div>
  );
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}