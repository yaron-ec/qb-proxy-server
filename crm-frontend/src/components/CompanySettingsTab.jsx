import { useState, useEffect, useRef, useCallback } from "react";
import * as railwayCompanySettings from "@/api/railway/companySettings";
import { Save, Check } from "lucide-react";

export default function CompanySettingsTab() {
  const [company, setCompany] = useState(null);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const debounceRef = useRef(null);
  const companyRef = useRef(null);

  useEffect(() => {
    railwayCompanySettings.get().then(data => {
      if (data) {
        setCompany(data);
        companyRef.current = data;
        setForm(data);
      } else {
        setCompany(null);
        companyRef.current = null;
        setForm({});
      }
      setLoading(false);
    }).catch(() => {
      setCompany(null);
      companyRef.current = null;
      setForm({});
      setLoading(false);
    });
  }, []);

  const doSave = useCallback(async (latestForm) => {
    setSaveState("saving");
    try {
      const updated = await railwayCompanySettings.upsert(latestForm);
      setCompany(updated);
      companyRef.current = updated;
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (err) {
      console.error("Save failed:", err.message);
      setSaveState("idle");
      // Revert to last saved state on error
      if (companyRef.current) {
        setForm(companyRef.current);
      }
    }
  }, []);

  const set = (key, value) => {
    const updated = { ...form, [key]: value };
    setForm(updated);
    // debounce auto-save 800ms
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSave(updated), 800);
  };

  if (loading) return <div className="text-center py-8 text-slate-500">Loading...</div>;

  const buttonClass = saveState === "saved"
    ? "flex items-center gap-2 bg-emerald-500 text-white px-4 py-2 text-sm font-bold rounded transition-all duration-300"
    : saveState === "saving"
    ? "flex items-center gap-2 bg-orange/70 text-white px-4 py-2 text-sm font-bold rounded transition-all duration-300"
    : "flex items-center gap-2 bg-orange text-white px-4 py-2 text-sm font-bold rounded hover:bg-orange/90 transition-all duration-300";

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded border border-slate-200 p-6">
        <h2 className="text-sm font-bold text-slate-700 mb-6">Company Information</h2>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Company Name *" value={form.company_name || ""} onChange={v => set("company_name", v)} />
            <Field label="Company Email" type="email" value={form.company_email || ""} onChange={v => set("company_email", v)} />
            <Field label="Company Phone" type="tel" value={form.company_phone || ""} onChange={v => set("company_phone", v)} />
            <Field label="Company Website" type="url" value={form.company_website || ""} onChange={v => set("company_website", v)} />
            <div className="col-span-2">
              <Field label="Company Address" value={form.company_address || ""} onChange={v => set("company_address", v)} />
            </div>
            <Field label="City" value={form.company_city || ""} onChange={v => set("company_city", v)} />
            <Field label="State" value={form.company_state || ""} onChange={v => set("company_state", v)} />
            <Field label="ZIP Code" value={form.company_zip || ""} onChange={v => set("company_zip", v)} />
            <Field label="Company Logo URL" type="url" value={form.company_logo_url || ""} onChange={v => set("company_logo_url", v)} />
          </div>
        </div>

        <div className="border-t border-slate-200 mt-8 pt-6">
          <h3 className="text-sm font-bold text-slate-700 mb-4">Admin Information</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Admin Name" value={form.admin_name || ""} onChange={v => set("admin_name", v)} />
            <Field label="Admin Email" type="email" value={form.admin_email || ""} onChange={v => set("admin_email", v)} />
          </div>
        </div>

        <div className="border-t border-slate-200 mt-8 pt-6">
          <h3 className="text-sm font-bold text-slate-700 mb-4">Notification Settings</h3>
          <div className="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={!!form.crm_activity_notifications_enabled}
              onClick={() => set("crm_activity_notifications_enabled", !form.crm_activity_notifications_enabled)}
              className={`relative mt-0.5 flex-shrink-0 w-10 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-orange/50 ${form.crm_activity_notifications_enabled ? 'bg-orange' : 'bg-slate-200'}`}
            >
              <span className={`block w-4 h-4 bg-white rounded-full shadow-sm absolute top-1 transition-all duration-200 ${form.crm_activity_notifications_enabled ? 'left-5' : 'left-1'}`} />
            </button>
            <div>
              <p className="text-sm font-semibold text-slate-800">Send CRM Activity Notifications to Yaron</p>
              <p className="text-xs text-slate-500 mt-0.5">
                When enabled, an email is sent to <span className="font-mono">yaron@ecconstructiongroup.com</span> whenever a sales rep logs a note, call, meeting, task, or when lead/deal activity changes.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            onClick={() => doSave(form)}
            disabled={saveState === "saving"}
            className={buttonClass}
          >
            {saveState === "saved" ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved!" : "Save Company Info"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        className="w-full border border-slate-200 rounded px-3 py-2 text-sm text-slate-800 bg-white focus:outline-none focus:border-orange transition-colors"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}