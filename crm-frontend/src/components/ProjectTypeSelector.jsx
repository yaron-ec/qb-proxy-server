import { useState, useEffect } from "react";
import * as railwaySettings from "@/api/railway/settings";
import { EC_PROJECT_TYPES } from "@/lib/projectTypes";
import { X, Loader2 } from "lucide-react";

export default function ProjectTypeSelector({ value, onSave, label = "Project Type" }) {
  const [showModal, setShowModal] = useState(false);
  // Default to the canonical EC_PROJECT_TYPES list (lib/projectTypes.js) —
  // the same pattern LeadCapture.jsx/Settings.jsx/LeadDetailModern.jsx use —
  // so the modal always has options to show. GET /api/v1/settings/app_lists
  // (below) is admin/manager-only (routes/settings.js#requireAdminOrManager);
  // a sales_rep editing their own deal's Project Type would get a 403 there,
  // and the setting may also simply never have been saved. Either way this
  // is a non-fatal, optional override — never the only source, which is what
  // previously left this component's list (and thus the modal body) empty.
  const [projectTypes, setProjectTypes] = useState(EC_PROJECT_TYPES);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [saving, setSaving] = useState(false);

  // Maps a stored token to its canonical casing from the current options list,
  // case-insensitively (e.g. a legacy "ADU / garage conversion" stored value
  // must match the canonical "ADU / Garage Conversion" checkbox). Without
  // this, a case/formatting difference between a stored value and the
  // canonical option it represents means the checkbox never shows as
  // selected, AND toggling that same checkbox later ADDS a second,
  // differently-cased entry instead of removing the existing one — silently
  // duplicating the same real-world type under two spellings. Falls back to
  // the raw token when no canonical equivalent exists in the current list.
  const canonicalize = (raw) => projectTypes.find(o => o.toLowerCase() === raw.toLowerCase()) || raw;

  const parseValue = (v) => {
    if (!v) return [];
    const tokens = Array.isArray(v) ? v : String(v).split(",").map(x => x.trim()).filter(Boolean);
    return tokens.map(canonicalize);
  };

  useEffect(() => {
    loadProjectTypes();
  }, []);

  useEffect(() => {
    // Parse initial value (can be comma-separated string or array). Also
    // re-runs when `projectTypes` resolves from its live-settings fetch, so
    // canonicalization is always matched against the final options list, not
    // just the initial EC_PROJECT_TYPES default.
    setSelectedTypes(parseValue(value));
  }, [value, projectTypes]);

  const loadProjectTypes = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const settings = await railwaySettings.get("app_lists");
      // Only override the canonical default when the live setting actually
      // has a non-empty list — an empty/missing value must never blank out
      // the options the user already saw from EC_PROJECT_TYPES.
      if (settings && Array.isArray(settings.value?.projectTypes) && settings.value.projectTypes.length > 0) {
        setProjectTypes(settings.value.projectTypes);
      }
    } catch (e) {
      // Non-fatal — the canonical EC_PROJECT_TYPES default (already in
      // state) remains fully usable. Common cause: 403 for a non-admin/
      // manager role (see comment above the projectTypes state).
      console.error("Error loading project types:", e);
      setLoadError(true);
    }
    setLoading(false);
  };

  const toggleType = (type) => {
    setSelectedTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  // Discards any unsaved checkbox changes by resetting to the last saved
  // `value` before closing — so a cancelled edit never leaks into the next
  // time the modal is opened.
  const handleClose = () => {
    setSelectedTypes(parseValue(value));
    setShowModal(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(selectedTypes);
      setShowModal(false);
    } catch (e) {
      // Keep the modal open on failure — never close as if the save
      // succeeded. The caller (e.g. DealDetail.jsx's updateField) is
      // responsible for surfacing the actual error message.
      console.error("Error saving project type:", e);
    } finally {
      setSaving(false);
    }
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={handleClose}>
          <div
            className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Select {label}s</h3>
              <button
                onClick={handleClose}
                className="p-1 hover:bg-slate-100 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {projectTypes.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                {loading ? (
                  <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
                ) : (
                  <p className="text-sm text-slate-400">No project types configured.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto mb-4">
                {loadError && (
                  <p className="text-xs text-slate-400 px-1 pb-1">
                    Showing the default list — couldn't load custom settings.
                  </p>
                )}
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
                onClick={handleClose}
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