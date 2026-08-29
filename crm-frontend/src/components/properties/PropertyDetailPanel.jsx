import { X, Key, Tag, Info, RefreshCw, Eye, Lock, AlertTriangle, Calendar } from "lucide-react";
import { CATEGORIES, PROPERTY_TYPES } from "./propertyDefinitions";

const TYPE_COLORS = {
  text: "bg-slate-100 text-slate-600",
  number: "bg-blue-100 text-blue-700",
  currency: "bg-emerald-100 text-emerald-700",
  date: "bg-purple-100 text-purple-700",
  dropdown: "bg-amber-100 text-amber-700",
  multi_select: "bg-orange/10 text-orange",
  boolean: "bg-pink-100 text-pink-700",
  user: "bg-cyan-100 text-cyan-700",
};

export default function PropertyDetailPanel({ prop, onClose, onEdit }) {
  if (!prop) return null;

  const category = CATEGORIES.find(c => c.id === prop.category);
  const typeLabel = PROPERTY_TYPES.find(t => t.value === prop.type)?.label || prop.type;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white border-l border-slate-200 shadow-2xl h-full overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="text-base font-bold text-slate-800">{prop.label}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{category?.icon} {category?.label}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-6 py-5 space-y-6">

          {/* System warning */}
          {prop.isSystem && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-700">
                <strong>System field.</strong> This is an internal sync ID or timestamp. Do not expose this value to end users or modify it manually.
              </div>
            </div>
          )}

          {/* Status badges */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Status</p>
            <div className="flex flex-wrap gap-2">
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${TYPE_COLORS[prop.type] || TYPE_COLORS.text}`}>
                {typeLabel}
              </span>
              {prop.required && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-600 border border-red-100">Required</span>}
              {prop.hidden && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-500">Hidden</span>}
              {!prop.editable && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-500"><Lock className="w-3 h-3" />Read-only</span>}
              {prop.synced && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-600"><RefreshCw className="w-3 h-3" />Synced</span>}
              {prop.isSystem && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">System</span>}
              {prop.isCustom && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-orange/10 text-orange">Custom</span>}
            </div>
          </div>

          {/* Description */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 flex items-center gap-1.5"><Info className="w-3 h-3" /> Description</p>
            <p className="text-sm text-slate-700">{prop.description || "No description provided."}</p>
          </div>

          {/* Internal key */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 flex items-center gap-1.5"><Key className="w-3 h-3" /> Internal Key</p>
            <code className="block text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 break-all">{prop.id}</code>
            <p className="text-[10px] text-slate-400 mt-1">This key is used internally and should never be shown to end users.</p>
          </div>

          {/* Details table */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5"><Tag className="w-3 h-3" /> Details</p>
            <div className="bg-slate-50 rounded-lg border border-slate-100 divide-y divide-slate-100 overflow-hidden">
              {[
                { label: "Display Label", value: prop.label },
                { label: "Property Type", value: typeLabel },
                { label: "Category", value: `${category?.icon} ${category?.label}` },
                { label: "Access", value: prop.editable ? "Editable by users" : "Read-only" },
                { label: "Visibility", value: prop.hidden ? "Hidden from view" : "Visible" },
                { label: "Required", value: prop.required ? "Yes" : "No" },
                { label: "Synced", value: prop.synced ? "Yes (external system)" : "No" },
                { label: "Field Source", value: prop.isCustom ? "Custom (admin-created)" : prop.isSystem ? "System (internal)" : "Built-in (Lead schema)" },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs text-slate-500">{row.label}</span>
                  <span className="text-xs font-semibold text-slate-800">{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Usage */}
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5"><Eye className="w-3 h-3" /> Used In</p>
            <div className="space-y-1">
              {prop.category === "lead_info" && <UsageTag label="Lead Detail View" color="blue" />}
              {prop.category === "sales" && <UsageTag label="Sales Panel" color="emerald" />}
              {prop.category === "quickbooks" && <UsageTag label="QuickBooks Sync" color="amber" />}
              {prop.category === "integrations" && <UsageTag label="Integration Dashboard" color="purple" />}
              {prop.isSystem && <UsageTag label="Backend Sync Engine" color="slate" />}
              {prop.synced && <UsageTag label="External Sync" color="blue" />}
              {!prop.category && <span className="text-xs text-slate-400">Not currently used in any views.</span>}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        {!prop.isSystem && (
          <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 flex gap-2">
            <button
              onClick={() => onEdit(prop)}
              className="flex-1 bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors"
            >
              Edit Property
            </button>
            <button onClick={onClose} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">
              Close
            </button>
          </div>
        )}
        {prop.isSystem && (
          <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100">
            <button onClick={onClose} className="w-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function UsageTag({ label, color }) {
  const colors = {
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    purple: "bg-purple-50 text-purple-700 border-purple-100",
    slate: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border mr-1 ${colors[color]}`}>{label}</span>
  );
}