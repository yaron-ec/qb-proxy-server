/**
 * KPIChip — compact financial metric chip for dashboards and detail pages.
 * Variants: default, balance, collected, remaining, invoiced
 */
import { useState, useEffect } from "react";
import { Pencil } from "lucide-react";

const fmtMoney = (v) => {
  const num = parseFloat(v) || 0;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

// Restrained variant: the CARD stays neutral white/bordered (matching
// card-premium everywhere else in the CRM) — only the VALUE text carries the
// semantic color, the same convention used for money in Deals.jsx's row
// (font-bold tabular-nums, colored text, no colored box). Keeps a group of
// these reading as one cohesive strip instead of several unrelated colored
// boxes competing for attention.
const VARIANT_TEXT = {
  default:   "text-slate-900",
  balance:   "text-amber-700",
  collected: "text-emerald-700",
  remaining: "text-slate-900",
  invoiced:  "text-slate-900",
};

export function KPIChip({ label, value, variant = "default", editable = false, onEdit = null, className = "" }) {
  // A zero value isn't "collected"/"outstanding" in any meaningful sense —
  // de-emphasize it rather than applying a semantic color that would imply
  // something happened (same convention as FollowUpsWidget's zero-value
  // metrics elsewhere in the CRM).
  const isZero = !(parseFloat(value) > 0);
  const textColor = isZero ? "text-slate-300" : (VARIANT_TEXT[variant] || VARIANT_TEXT.default);
  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white px-3 py-2 flex flex-col gap-0.5 min-w-[100px] ${editable ? "cursor-pointer hover:border-slate-300 hover:shadow-sm group transition-all" : ""} ${className}`}
      onClick={() => editable && onEdit?.()}
    >
      <div className="flex items-center gap-1">
        <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide leading-none">{label}</p>
        {editable && <Pencil className="w-2 h-2 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>
      <p className={`text-sm font-bold leading-tight tabular-nums ${textColor}`}>{fmtMoney(value)}</p>
    </div>
  );
}

export function KPIChipGroup({ chips, className = "" }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {chips.map((chip, i) => (
        <KPIChip key={i} {...chip} />
      ))}
    </div>
  );
}

export function EditableKPIChip({ label, value, variant = "default", onSave, className = "" }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value || 0));

  useEffect(() => { setEditValue(String(value || 0)); }, [value]);

  if (isEditing) {
    return (
      <div className="rounded-lg border-2 border-amber-400 bg-white px-3 py-2 flex flex-col gap-1.5 min-w-[120px]">
        <p className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
        <input
          type="number"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-500"
          autoFocus
        />
        <div className="flex gap-1">
          <button
            onClick={() => { onSave(editValue); setIsEditing(false); }}
            className="flex-1 px-2 py-1 text-[10px] font-semibold bg-amber-600 text-white rounded hover:bg-amber-700"
          >
            Save
          </button>
          <button
            onClick={() => { setEditValue(String(value || 0)); setIsEditing(false); }}
            className="flex-1 px-2 py-1 text-[10px] font-semibold border border-slate-200 text-slate-600 rounded hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <KPIChip
      label={label}
      value={value}
      variant={variant}
      editable
      onEdit={() => setIsEditing(true)}
      className={className}
    />
  );
}