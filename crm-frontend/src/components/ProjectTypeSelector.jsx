import { useState, useEffect } from "react";
import * as railwaySettings from "@/api/railway/settings";
import { X, Loader2 } from "lucide-react";

export default function ProjectTypeSelector({ value, onSave, label = "Project Type" }) {
  const [showModal, setShowModal] = useState(false);
  const [projectTypes, setProjectTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProjectTypes();
  }, []);

  useEffect(() => {
    // Parse initial value (can be comma-separated string or array)
    if (value) {
      const types = Array.isArray(value) 
        ? value 
        : String(value).split(",").map(v => v.trim()).filter(v => v);
      setSelectedTypes(types);
    }
  }, [value]);

  const loadProjectTypes = async () => {
    setLoading(true);
    try {
      const settings = await railwaySettings.get("app_lists");
      if (settings && settings.value?.projectTypes) {
        setProjectTypes(settings.value.projectTypes);
      }
    } catch (e) {
      console.error("Error loading project types:", e);
    }
    setLoading(false);
  };

  const toggleType = (type) => {
    setSelectedTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave(selectedTypes);
    setSaving(false);
    setShowModal(false);
  };

  const displayValue = Array.isArray(value) 
    ? value.join(", ") 
    : (value || "—");

  return (
    <>
      <div 
        onClick={() => setShowModal(true)}
        className="cursor-pointer group"
      >
        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
        <div className="flex items-center justify-between group-hover:bg-slate-50 rounded px-2 py-1 transition-colors">
          {selectedTypes.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {selectedTypes.map((t, i) => (
                <span key={i} className="text-xs bg-amber-100 text-amber-900 px-2 py-1 rounded">
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-900">{displayValue}</p>
          )}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div 
            className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Select {label}s</h3>
              <button 
                onClick={() => setShowModal(false)}
                className="p-1 hover:bg-slate-100 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto mb-4">
                {projectTypes.map(type => (
                  <label 
                    key={type}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTypes.includes(type)}
                      onChange={() => toggleType(type)}
                      className="w-4 h-4 rounded border-slate-300 accent-amber-600"
                    />
                    <span className="text-sm text-slate-700">{type}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 text-sm font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}