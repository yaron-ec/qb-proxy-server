/**
 * EditableFields — shared editable field components for Deal/Lead detail tabs.
 */
import { useState } from "react";
import { Pencil } from "lucide-react";

export function EditableInfoRow({ icon: Icon, label, value, onSave, saving, type = "text", isReadOnly = false }) {
  const [isEditing, setIsEditing] = useState(false);

  const getDisplayValue = (val) => {
    if (Array.isArray(val)) return val.join(", ");
    if (!val) return "";
    if (type === "date") {
      try {
        const dateStr = typeof val === "string" ? val.split("T")[0] : val;
        return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      } catch { return val; }
    }
    return val;
  };

  const displayValue = getDisplayValue(value);
  const [editValue, setEditValue] = useState(
    type === "date" && value ? (typeof value === "string" ? value.split("T")[0] : value) : displayValue
  );

  const handleSave = async () => {
    await onSave(editValue);
    setIsEditing(false);
  };

  if (isEditing && !isReadOnly) {
    return (
      <div className="flex items-start gap-2.5">
        <Icon className="w-4 h-4 text-slate-400 flex-shrink-0 mt-2" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
          <input
            type={type}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-amber-300 rounded focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            autoFocus
          />
          <div className="flex gap-1.5">
            <button onClick={handleSave} disabled={saving}
              className="text-xs font-semibold px-2 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setIsEditing(false)}
              className="text-xs font-semibold px-2 py-1 border border-slate-200 rounded hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex items-start gap-2.5 ${!isReadOnly ? "group cursor-pointer hover:bg-slate-50" : ""} p-1.5 rounded -mx-1.5 transition-colors`}
      onClick={() => !isReadOnly && setIsEditing(true)}
    >
      <Icon className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
        <p className="text-sm text-slate-900 mt-0.5 group-hover:text-amber-600 transition-colors">{displayValue || "—"}</p>
      </div>
      {!isReadOnly && <Pencil className="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />}
    </div>
  );
}

export function EditableClientField({ label, value, type = "text", onSave }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);

  const handleSave = async () => {
    await onSave(editValue);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="space-y-1.5">
        <input
          type={type}
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          className="w-full px-2 py-1 text-xs border border-orange rounded focus:outline-none focus:ring-2 focus:ring-orange/20"
          autoFocus
        />
        <div className="flex gap-1">
          <button onClick={handleSave}
            className="text-xs font-semibold px-2 py-1 bg-orange text-white rounded hover:bg-orange/90">
            Save
          </button>
          <button onClick={() => { setEditValue(value); setIsEditing(false); }}
            className="text-xs font-semibold px-2 py-1 border border-slate-200 rounded hover:bg-slate-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div onClick={() => setIsEditing(true)} className="cursor-pointer hover:bg-slate-50 p-1 rounded -m-1 transition-colors">
      {label === "Name" ? (
        <p className="text-sm font-semibold text-slate-900">{value}</p>
      ) : (
        <a href={`tel:${value}`} onClick={e => e.stopPropagation()} className="text-xs text-slate-500 hover:text-slate-700 block">{value || "—"}</a>
      )}
    </div>
  );
}