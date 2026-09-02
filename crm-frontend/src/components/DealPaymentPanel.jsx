import { useState, useEffect } from "react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayInvoices from "@/api/railway/invoices";
import { DollarSign, Check, ChevronDown, ChevronUp, Zap, AlertCircle } from "lucide-react";
import { PaymentTable } from "@/components/DesignSystem";
import { getDealPaymentSummary } from "@/lib/financialCalc";

const fmtMoney = (v) => v != null && v !== "" ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : "$0";
const fmtDate  = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

/**
 * Derives the suggested stage from payment milestones.
 * Works with both deal fields and structured milestone arrays.
 */
export function deriveStageFromPayments(deal) {
  const total        = deal.amount || 0;
  const deposit      = deal.deposit_amount || 0;
  const depositPaid  = deal.deposit_paid || 0;
  const progress     = deal.progress_payment_amount || 0;
  const progressPaid = deal.progress_payment_paid || 0;
  const final        = deal.final_payment_amount || 0;
  const finalPaid    = deal.final_payment_paid || 0;

  const totalPaid = depositPaid + progressPaid + finalPaid;

  if (total > 0 && totalPaid >= total) return "Job Completed";
  if (final > 0 && finalPaid >= final) return "Final Payment Paid";
  if (final > 0 && finalPaid < final && progressPaid > 0) return "Final Payment Due";
  if (progress > 0 && progressPaid >= progress) return "Progress Payment Paid";
  if (progress > 0 && progressPaid < progress && depositPaid > 0) return "Progress Payment Due";
  if (deposit > 0 && depositPaid >= deposit) return "Deposit Paid";
  if (deposit > 0 && depositPaid < deposit) return "Deposit Due";
  return null;
}

/**
 * Build milestone list from Invoice records (Handoff/QB sourced).
 * Falls back to deal fields if no invoices exist.
 */
function buildMilestonesFromInvoices(invoices, deal) {
  if (!invoices || invoices.length === 0) return null;

  // Only include invoices with a recognized payment_stage
  const stageOrder = ["deposit", "progress payment", "final payment", "custom"];
  const sorted = [...invoices].sort((a, b) => {
    const ai = stageOrder.indexOf(a.payment_stage || "custom");
    const bi = stageOrder.indexOf(b.payment_stage || "custom");
    return ai - bi;
  });

  return sorted.map(inv => ({
    id:        inv.id,
    label:     stageLabel(inv.payment_stage, inv.description),
    due:       inv.amount || 0,
    paid:      inv.payment_received || 0,
    date:      inv.payment_date || null,
    dueDate:   inv.due_date || null,
    status:    inv.payment_status || "unpaid",  // unpaid | partial | paid
    qbLinked:  !!inv.qb_invoice_id,
    stage:     inv.payment_stage,
    invoiceId: inv.id,
    note:      inv.notes || null,  // "Received For" from Invoice.notes
  }));
}

function stageLabel(stage, description) {
  if (description && description.trim()) return description.trim();
  const map = {
    "deposit":          "Deposit",
    "progress payment": "Progress Payment",
    "final payment":    "Final Payment",
    "custom":           "Payment",
  };
  return map[stage] || "Payment";
}

function deriveStageFromMilestones(milestones, total) {
  if (!milestones || milestones.length === 0) return null;

  const totalPaid = milestones.reduce((s, m) => s + (m.paid || 0), 0);
  if (total > 0 && totalPaid >= total) return "Job Completed";

  // Walk milestones in reverse to find the furthest reached
  for (let i = milestones.length - 1; i >= 0; i--) {
    const m = milestones[i];
    if (m.paid >= m.due && m.due > 0) {
      const labels = ["deposit", "progress payment", "final payment"];
      if (m.stage === "final payment") return "Final Payment Paid";
      if (m.stage === "progress payment") return "Progress Payment Paid";
      if (m.stage === "deposit") return "Deposit Paid";
      return null;
    }
    if (m.paid > 0 && m.paid < m.due) {
      if (m.stage === "final payment") return "Final Payment Due";
      if (m.stage === "progress payment") return "Progress Payment Due";
      if (m.stage === "deposit") return "Deposit Due";
      return null;
    }
  }

  // Nothing paid — check if deposit exists
  const deposit = milestones.find(m => m.stage === "deposit");
  if (deposit && deposit.due > 0) return "Deposit Due";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DealPaymentPanel({ deal, lead, onDealUpdate, estimate, invoices = [] }) {
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // Determine source: use invoice milestones if available
  const invoiceMilestones = buildMilestonesFromInvoices(invoices, deal);
  const hasInvoiceData    = invoiceMilestones && invoiceMilestones.length > 0;

  // ── Single source of truth — shared helper (same as Financial tab, Financial
  //    Summary, Dashboard, Reports). Never recalculate payment totals here. ──
  const fin = getDealPaymentSummary(deal, lead, invoices);

  // Project Total — same calc as FinancialTab/FinancialSummary
  const estimateTotal = estimate?.estimate_amount || null;
  const total        = fin.projectTotal || (hasInvoiceData ? invoices.reduce((s, i) => s + (i.amount || 0), 0) : 0);

  // Auto-sync deal amount from estimate if deal.amount is not set
  useEffect(() => {
    if (estimateTotal && !deal.amount && estimateTotal !== deal.amount) {
      railwayDeals.update(deal.id, { amount: estimateTotal }).then(onDealUpdate);
    }
  }, [estimateTotal, deal.amount]);

  // Auto-derive stage from invoice milestones
  useEffect(() => {
    if (!deal.stage_override && hasInvoiceData) {
      const suggested = deriveStageFromMilestones(invoiceMilestones, total);
      if (suggested && suggested !== deal.stage) {
        railwayDeals.update(deal.id, { stage: suggested }).then(onDealUpdate);
      }
    }
  }, [invoices, deal.stage_override]);

  // Parse "Received For" notes from Deal.notes (structured section)
  const parsePaymentNotes = (notesStr) => {
    const result = { deposit: "", progress: "", final: "" };
    if (!notesStr) return result;
    const m = notesStr.match(/--- Payment Notes ---\n([\s\S]*?)--- End ---/);
    if (!m) return result;
    for (const line of m[1].split("\n")) {
      const dm = line.match(/^Deposit:\s*(.*)/);  if (dm) result.deposit = dm[1];
      const pm = line.match(/^Progress:\s*(.*)/);  if (pm) result.progress = pm[1];
      const fm = line.match(/^Final:\s*(.*)/);     if (fm) result.final = fm[1];
    }
    return result;
  };
  const parsedNotes = parsePaymentNotes(deal.notes);

  // Manual deal-field edit form (used when no invoice data)
  const [form, setForm] = useState({
    deposit_amount:             deal.deposit_amount || "",
    deposit_paid:               deal.deposit_paid || "",
    deposit_paid_date:          deal.deposit_paid_date || "",
    deposit_note:               parsedNotes.deposit,
    progress_payment_amount:    deal.progress_payment_amount || "",
    progress_payment_paid:      deal.progress_payment_paid || "",
    progress_payment_paid_date: deal.progress_payment_paid_date || "",
    progress_note:              parsedNotes.progress,
    final_payment_amount:       deal.final_payment_amount || "",
    final_payment_paid:         deal.final_payment_paid || "",
    final_payment_paid_date:    deal.final_payment_paid_date || "",
    final_note:                 parsedNotes.final,
    work_start_date:            deal.work_start_date || "",
    work_end_date:              deal.work_end_date || "",
  });

  // Milestones for the payment table display
  const displayMilestones = hasInvoiceData ? invoiceMilestones : buildFallbackMilestones(deal);

  // Totals — from the shared helper so Payment Progress always matches the
  // Financial Summary and the Financial tab KPI chips.
  const totalPaid = fin.paid;
  const balance   = fin.balance;
  const pctPaid   = fin.pctPaid;

  const handleSave = async () => {
    setSaving(true);

    const depositAmount   = parseFloat(form.deposit_amount) || 0;
    const depositPaid     = parseFloat(form.deposit_paid) || 0;
    const progressAmount  = parseFloat(form.progress_payment_amount) || 0;
    const progressPaid    = parseFloat(form.progress_payment_paid) || 0;
    const finalAmount     = parseFloat(form.final_payment_amount) || 0;
    const finalPaid       = parseFloat(form.final_payment_paid) || 0;

    const totalPaid         = depositPaid + progressPaid + finalPaid;
    const milestoneTotal    = depositAmount + progressAmount + finalAmount;

    // Single source of truth for contract_amount:
    // Use existing deal.contract_amount if set, otherwise derive from milestones
    const contractAmount = deal.contract_amount || milestoneTotal;
    const balanceDue     = Math.max(0, contractAmount - totalPaid);

    const payload = {
      deposit_amount:             depositAmount,
      deposit_paid:               depositPaid,
      deposit_paid_date:          form.deposit_paid_date || null,
      progress_payment_amount:    progressAmount,
      progress_payment_paid:      progressPaid,
      progress_payment_paid_date: form.progress_payment_paid_date || null,
      final_payment_amount:       finalAmount,
      final_payment_paid:         finalPaid,
      final_payment_paid_date:    form.final_payment_paid_date || null,
      work_start_date:            form.work_start_date || null,
      work_end_date:              form.work_end_date || null,
      // Always write summary fields so Deal cards stay in sync
      total_paid:      totalPaid,
      balance_due:     balanceDue,
      paid_percentage: contractAmount > 0 ? Math.round((totalPaid / contractAmount) * 100) : 0,
      payment_status:  totalPaid === 0 ? "unpaid" : totalPaid >= contractAmount ? "paid" : "partial",
    };

    // Only update contract_amount from milestones if not yet explicitly set
    if (!deal.contract_amount && milestoneTotal > 0) {
      payload.contract_amount = milestoneTotal;
    }

    // Serialize "Received For" notes into Deal.notes (structured section, preserves existing notes)
    const existingNotes = (deal.notes || "").replace(/--- Payment Notes ---\n[\s\S]*?--- End ---/, "").trim();
    const noteLines = [];
    if (form.deposit_note?.trim())  noteLines.push(`Deposit: ${form.deposit_note.trim()}`);
    if (form.progress_note?.trim()) noteLines.push(`Progress: ${form.progress_note.trim()}`);
    if (form.final_note?.trim())    noteLines.push(`Final: ${form.final_note.trim()}`);
    const notesSection = noteLines.length > 0
      ? `--- Payment Notes ---\n${noteLines.join("\n")}\n--- End ---`
      : "";
    payload.notes = [existingNotes, notesSection].filter(Boolean).join("\n\n") || null;

    if (!deal.stage_override) {
      const suggested = deriveStageFromPayments({ ...deal, ...payload });
      if (suggested) payload.stage = suggested;
    }

    const updateRes = await railwayDeals.update(deal.id, payload);
    const updated = updateRes?.deal || updateRes;
    onDealUpdate(updated);
    setSaving(false);
    setEditMode(false);
  };

  return (
    <div className="card-premium overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-semibold text-slate-800">Payment Progress</span>
          {hasInvoiceData && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded-full">
              <Zap className="w-2.5 h-2.5" />
              From Handoff
            </span>
          )}
          {total > 0 && (
            <span className="text-xs text-slate-400 font-medium">{pctPaid}% paid</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editMode && !hasInvoiceData && (
            <button
              onClick={e => { e.stopPropagation(); setEditMode(true); setExpanded(true); }}
              className="text-xs font-semibold text-amber-600 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50 transition-colors"
            >
              Edit
            </button>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">

          {/* Estimate source banner */}
          {estimate && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs text-blue-700 font-semibold">
                  Estimate #{estimate.handoff_estimate_number || estimate.qb_estimate_number || "—"}
                </span>
                <span className="text-xs text-blue-500 ml-1">
                  · {estimate.estimate_status} · {fmtMoney(estimate.estimate_amount)}
                </span>
              </div>
              {estimate.document_url && (
                <a
                  href={estimate.document_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="text-[10px] font-semibold text-blue-600 hover:underline flex-shrink-0"
                >
                  View PDF
                </a>
              )}
            </div>
          )}

          {/* Progress bar */}
          {total > 0 && (
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                <span>Paid: <span className="font-semibold text-slate-800">{fmtMoney(totalPaid)}</span></span>
                <span>Total: <span className="font-semibold text-slate-800">{fmtMoney(total)}</span></span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all duration-500"
                  style={{ width: `${pctPaid}%` }}
                />
              </div>
              <div className="flex justify-between text-xs mt-1.5">
                <span className={`font-semibold ${balance === 0 ? "text-green-600" : "text-slate-600"}`}>
                  {balance === 0 ? "✓ Paid in full" : `Balance due: ${fmtMoney(balance)}`}
                </span>
                <span className="text-slate-400">{pctPaid}%</span>
              </div>
            </div>
          )}

          {/* Milestones — compact table */}
          {!editMode && displayMilestones.length > 0 && (
            <PaymentTable
              milestones={displayMilestones}
              onMarkPaid={hasInvoiceData ? async (m) => {
                await railwayInvoices.update(m.invoiceId, {
                  payment_received: m.due,
                  payment_status:   "paid",
                  payment_date:     new Date().toISOString().split("T")[0],
                });
                const dealRes = await railwayDeals.get(deal.id);
                const updated = dealRes?.deal || dealRes;
                onDealUpdate(updated);
              } : undefined}
              onEditNote={hasInvoiceData ? async (m, value) => {
                await railwayInvoices.update(m.invoiceId, { notes: value || null });
              } : undefined}
            />
          )}

          {/* Empty state */}
          {!editMode && displayMilestones.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-2">
              No payment milestones. {hasInvoiceData ? "" : "Click Edit to add them manually."}
            </p>
          )}

          {/* Manual edit form (only when no invoice data) */}
          {editMode && !hasInvoiceData && (
            <div className="space-y-4">
              <PaymentRow label="Deposit"          amountKey="deposit_amount"          paidKey="deposit_paid"          dateKey="deposit_paid_date"          noteKey="deposit_note"          form={form} setForm={setForm} />
              <PaymentRow label="Progress Payment" amountKey="progress_payment_amount" paidKey="progress_payment_paid" dateKey="progress_payment_paid_date" noteKey="progress_note"          form={form} setForm={setForm} />
              <PaymentRow label="Final Payment"    amountKey="final_payment_amount"    paidKey="final_payment_paid"    dateKey="final_payment_paid_date"    noteKey="final_note"            form={form} setForm={setForm} />

              <div className="h-px bg-slate-100" />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Work Start Date</label>
                  <input type="date" value={form.work_start_date} onChange={e => setForm(p => ({ ...p, work_start_date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Work End Date</label>
                  <input type="date" value={form.work_end_date} onChange={e => setForm(p => ({ ...p, work_end_date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500" />
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50 transition-colors">
                  {saving ? "Saving…" : "Save Payments"}
                </button>
                <button onClick={() => setEditMode(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFallbackMilestones(deal) {
  return [
    { id: "dep", label: "Deposit",          due: deal.deposit_amount || 0,          paid: deal.deposit_paid || 0,          date: deal.deposit_paid_date,          dueDate: null, status: (deal.deposit_paid || 0) >= (deal.deposit_amount || 0) && (deal.deposit_amount || 0) > 0 ? "paid" : "unpaid", qbLinked: false, stage: "deposit" },
    { id: "prg", label: "Progress Payment", due: deal.progress_payment_amount || 0, paid: deal.progress_payment_paid || 0, date: deal.progress_payment_paid_date,  dueDate: null, status: (deal.progress_payment_paid || 0) >= (deal.progress_payment_amount || 0) && (deal.progress_payment_amount || 0) > 0 ? "paid" : "unpaid", qbLinked: false, stage: "progress payment" },
    { id: "fin", label: "Final Payment",    due: deal.final_payment_amount || 0,    paid: deal.final_payment_paid || 0,    date: deal.final_payment_paid_date,     dueDate: null, status: (deal.final_payment_paid || 0) >= (deal.final_payment_amount || 0) && (deal.final_payment_amount || 0) > 0 ? "paid" : "unpaid", qbLinked: false, stage: "final payment" },
  ].filter(m => m.due > 0 || m.paid > 0);
}

function ManualPaidToggle({ invoice, dealId, onDealUpdate }) {
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState(invoice.note || "");
  return (
    <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5">
      <input
        type="text"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Received For (e.g. Check #123)"
        className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white"
      />
      <button
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          await railwayInvoices.update(invoice.invoiceId, {
            payment_received: invoice.due,
            payment_status:   "paid",
            payment_date:     new Date().toISOString().split("T")[0],
            notes:            note.trim() || null,
          });
          const dealRes = await railwayDeals.get(dealId);
          const updated = dealRes?.deal || dealRes;
          onDealUpdate(updated);
          setLoading(false);
        }}
        className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 hover:bg-amber-50 px-2 py-1 rounded transition-colors disabled:opacity-50"
      >
        {loading ? "Saving…" : "Mark as Paid"}
      </button>
    </div>
  );
}

function PaymentRow({ label, amountKey, paidKey, dateKey, noteKey, form, setForm }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Amount Due</label>
          <input type="number" value={form[amountKey]} onChange={e => setForm(p => ({ ...p, [amountKey]: e.target.value }))}
            placeholder="$0" className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Amount Paid</label>
          <input type="number" value={form[paidKey]} onChange={e => setForm(p => ({ ...p, [paidKey]: e.target.value }))}
            placeholder="$0" className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Date Paid</label>
          <input type="date" value={form[dateKey]} onChange={e => setForm(p => ({ ...p, [dateKey]: e.target.value }))}
            className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Received For</label>
          <input type="text" value={form[noteKey] || ""} onChange={e => setForm(p => ({ ...p, [noteKey]: e.target.value }))}
            placeholder="e.g. Check #123" className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white" />
        </div>
      </div>
    </div>
  );
}