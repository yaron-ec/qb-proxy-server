import { useState } from "react";
import { X, Save } from "lucide-react";
import { CATEGORIES, PROPERTY_TYPES } from "./propertyDefinitions";

export default function PropertyModal({ property, onSave, onClose }) {
  const isNew = !property?.id;
  const [form, setForm] = useState({
    label: property?.label || "",
    type: property?.type || "text",
    category: property?.category || "lead_info",
    description: property?.description || "",
    required: property?.required || false,
    editable: property?.editable !== false,
    hidden: property?.hidden || false,
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-800">{isNew ? "Create Property" : "Edit Property"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Label <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.label}
              onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
              placeholder="e.g. Project Value"
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Property Type</label>
              <select
                value={form.type}
                onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              >
                {PROPERTY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Category</label>
              <select
                value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              >
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Description / Help Text</label>
            <textarea
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              placeholder="Describe what this property is used for..."
              rows={2}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors resize-none"
            />
          </div>

          {/* Toggles */}
          <div className="space-y-2.5 pt-1">
            {[
              { key: "required", label: "Required field", desc: "Must be filled when creating a lead" },
              { key: "editable", label: "Editable by users", desc: "Can be changed from the lead detail view" },
              { key: "hidden",   label: "Hidden from view", desc: "Only visible to admins in this panel" },
            ].map(({ key, label, desc }) => (
              <label key={key} className="flex items-center justify-between gap-3 cursor-pointer group">
                <div>
                  <div className="text-sm font-medium text-slate-700">{label}</div>
                  <div className="text-xs text-slate-400">{desc}</div>
                </div>
                <div
                  onClick={() => setForm(p => ({ ...p, [key]: !p[key] }))}
                  className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${form[key] ? 'bg-orange' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form[key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onClose} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={!form.label.trim()}
            className="bg-orange text-white px-5 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <Save className="w-3.5 h-3.5" />
            {isNew ? "Create Property" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}