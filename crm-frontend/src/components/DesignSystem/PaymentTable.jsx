/**
 * PaymentTable — responsive payment schedule.
 * Desktop: table with columns (Description | Due | Paid | Date | Status)
 * Mobile: stacked compact cards.
 */
import { useState, useEffect } from "react";
import { Check } from "lucide-react";

function NoteCell({ initialValue, onSave, editable }) {
  const [value, setValue] = useState(initialValue || "");
  useEffect(() => { setValue(initialValue || ""); }, [initialValue]);

  if (!editable) {
    return <span className="text-slate-500 text-[11px] truncate">{initialValue || "—"}</span>;
  }

  return (
    <input
      type="text"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => { if (value !== (initialValue || "")) onSave?.(value); }}
      placeholder="e.g. Check #123"
      className="w-full px-1.5 py-0.5 text-[11px] border border-transparent rounded hover:border-slate-200 focus:border-amber-400 focus:outline-none bg-transparent"
    />
  );
}

const fmtMoney = (v) => v != null && v !== "" ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : "—";
const fmtDate = (d) => {
  if (!d) return "—";
  try { return new Date(d.includes("T") ? d : d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return "—"; }
};

const STATUS_STYLES = {
  paid:    { dot: "bg-emerald-500", text: "text-emerald-600", label: "Paid" },
  partial: { dot: "bg-amber-500",   text: "text-amber-600",   label: "Partial" },
  unpaid:  { dot: "bg-slate-300",   text: "text-slate-400",   label: "Due" },
};

export function PaymentTable({ milestones, onMarkPaid, onEditNote, className = "" }) {
  if (!milestones || milestones.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-slate-400">
        No payment milestones yet.
      </div>
    );
  }

  return (
    <div className={className}>
      {/* ── Desktop table (md+) ── */}
      <div className="hidden md:block overflow-x-auto border border-slate-200 rounded-lg">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr_1.3fr_auto] gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <span>Description / Received For</span>
            <span className="text-right">Amount Due</span>
            <span className="text-right">Amount Paid</span>
            <span>Date Paid</span>
            <span>Received For</span>
            <span className="text-center w-16">Status</span>
          </div>
          {milestones.map((m, idx) => {
            const isPaid = m.status === "paid" || (m.paid >= m.due && m.due > 0);
            const isPartial = m.status === "partial" || (m.paid > 0 && m.paid < m.due);
            const status = isPaid ? "paid" : isPartial ? "partial" : "unpaid";
            const style = STATUS_STYLES[status];
            return (
              <div
                key={m.id || idx}
                className={`grid grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr_1.3fr_auto] gap-2 px-3 py-2.5 border-b border-slate-100 last:border-0 items-center text-xs hover:bg-slate-50/50 transition-colors ${isPaid ? "bg-emerald-50/20" : ""}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
                  <span className="font-semibold text-slate-700 truncate">{m.label}</span>
                  {m.qbLinked && <span className="text-[8px] font-bold text-blue-500 bg-blue-50 px-1 rounded">QB</span>}
                </div>
                <span className="text-right text-slate-600 font-medium">{fmtMoney(m.due)}</span>
                <span className={`text-right font-bold ${isPaid ? "text-emerald-700" : "text-slate-700"}`}>{fmtMoney(m.paid)}</span>
                <span className="text-slate-500">{fmtDate(m.date)}</span>
                <NoteCell initialValue={m.note} onSave={val => onEditNote?.(m, val)} editable={!!onEditNote} />
                <div className="flex items-center justify-center w-16">
                  {isPaid ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : onMarkPaid ? (
                    <button onClick={() => onMarkPaid(m)} className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 px-2 py-0.5 rounded hover:bg-amber-50 transition-colors btn-compact">
                      Mark Paid
                    </button>
                  ) : (
                    <span className={`text-[10px] font-semibold ${style.text}`}>{style.label}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Mobile stacked cards (<md) ── */}
      <div className="md:hidden space-y-2">
        {milestones.map((m, idx) => {
          const isPaid = m.status === "paid" || (m.paid >= m.due && m.due > 0);
          const isPartial = m.status === "partial" || (m.paid > 0 && m.paid < m.due);
          const status = isPaid ? "paid" : isPartial ? "partial" : "unpaid";
          const style = STATUS_STYLES[status];
          return (
            <div key={m.id || idx} className={`border border-slate-200 rounded-lg p-3 ${isPaid ? "bg-emerald-50/30" : "bg-white"}`}>
              {/* Row 1: status dot + label + QB badge */}
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
                <span className="text-sm font-semibold text-slate-800 flex-1 min-w-0 truncate">{m.label}</span>
                {m.qbLinked && <span className="text-[8px] font-bold text-blue-500 bg-blue-50 px-1 rounded flex-shrink-0">QB</span>}
                {isPaid ? (
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                ) : onMarkPaid ? (
                  <button onClick={() => onMarkPaid(m)} className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 px-2.5 py-1 rounded bg-amber-50 hover:bg-amber-100 transition-colors btn-compact flex-shrink-0">
                    Mark Paid
                  </button>
                ) : (
                  <span className={`text-[10px] font-semibold ${style.text} flex-shrink-0`}>{style.label}</span>
                )}
              </div>
              {/* Row 2: Amount Due / Amount Paid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide">Amount Due</p>
                  <p className="font-semibold text-slate-700">{fmtMoney(m.due)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide">Amount Paid</p>
                  <p className={`font-bold ${isPaid ? "text-emerald-700" : "text-slate-700"}`}>{fmtMoney(m.paid)}</p>
                </div>
              </div>
              {/* Row 3: Date Paid */}
              {m.date && (
                <div className="mt-2 text-xs">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wide">Date Paid: </span>
                  <span className="text-slate-600">{fmtDate(m.date)}</span>
                </div>
              )}
              {/* Row 4: Received For (inline edit) */}
              {onEditNote && (
                <div className="mt-2">
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Received For</p>
                  <NoteCell initialValue={m.note} onSave={val => onEditNote?.(m, val)} editable={true} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}