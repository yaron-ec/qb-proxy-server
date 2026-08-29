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

const VARIANT_STYLES = {
  default:   "bg-white border-slate-200 text-slate-900",
  balance:   "bg-amber-50 border-amber-200 text-amber-700",
  collected: "bg-emerald-50 border-emerald-200 text-emerald-700",
  remaining: "bg-blue-50 border-blue-200 text-blue-700",
  invoiced:  "bg-purple-50 border-purple-200 text-purple-700",
};

export function KPIChip({ label, value, variant = "default", editable = false, onEdit = null, className = "" }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 flex flex-col gap-0.5 min-w-[100px] ${VARIANT_STYLES[variant] || VARIANT_STYLES.default} ${editable ? "cursor-pointer hover:shadow-sm group transition-all" : ""} ${className}`}
      onClick={() => editable && onEdit?.()}
    >
      <div className="flex items-center gap-1">
        <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide leading-none">{label}</p>
        {editable && <Pencil className="w-2 h-2 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>
      <p className="text-sm font-bold leading-tight">{fmtMoney(value)}</p>
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