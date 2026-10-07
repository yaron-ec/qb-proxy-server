import { useState, useEffect, useCallback } from "react";
import { apiCall } from "@/api/railway/client";
import { Loader2, Bell, Check } from "lucide-react";

const CATEGORY_LABELS = {
  new_lead: "New Lead",
  appointment: "Appointment",
  follow_up: "Follow-Up",
  reminder: "Reminder",
  overdue: "Overdue",
  estimate: "Estimate",
  invoice_payment: "Invoice / Payment",
  contract_signed: "Contract Signed",
  sold: "Sold",
  system_failure: "System Failure",
};

/**
 * NotificationPreferencesTab — admin control for which notification
 * categories each staff member receives (CRM STABILITY PHASE, Section H).
 *
 * A user not listed here, or a category with no override, is ENABLED by
 * default — this screen only shows and sets explicit opt-outs; it never
 * invents a recipient who isn't already in Company Info's notification
 * recipient list.
 */
export default function NotificationPreferencesTab({ readOnly } = {}) {
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState("");
  const [preferences, setPreferences] = useState(null);
  const [loadingPrefs, setLoadingPrefs] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiCall('/api/v1/users', { method: 'GET' }).then((data) => {
      const items = data.items || data || [];
      setUsers(items);
      if (items.length > 0) setSelectedEmail(items[0].email);
      setLoadingUsers(false);
    }).catch((e) => {
      setError(e?.message || 'Failed to load staff directory.');
      setLoadingUsers(false);
    });
  }, []);

  const loadPreferences = useCallback((email) => {
    if (!email) return;
    setLoadingPrefs(true);
    setError(null);
    apiCall(`/api/v1/notification-preferences/${encodeURIComponent(email)}`, { method: 'GET' }).then((data) => {
      setPreferences(data.preferences || []);
      setLoadingPrefs(false);
    }).catch((e) => {
      setError(e?.message || 'Failed to load preferences.');
      setLoadingPrefs(false);
    });
  }, []);

  useEffect(() => { loadPreferences(selectedEmail); }, [selectedEmail, loadPreferences]);

  const toggleCategory = async (category, currentEnabled) => {
    if (readOnly) return;
    setSaving(category);
    try {
      const data = await apiCall(`/api/v1/notification-preferences/${encodeURIComponent(selectedEmail)}`, {
        method: 'PUT',
        body: { category, enabled: !currentEnabled },
      });
      setPreferences(data.preferences || []);
    } catch (e) {
      setError(e?.message || 'Failed to update preference.');
    } finally {
      setSaving(null);
    }
  };

  if (loadingUsers) {
    return <div className="p-4 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading staff directory...</div>;
  }

  return (
    <div className="p-4 max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <Bell className="w-4 h-4 text-amber-600" />
        <h3 className="text-sm font-bold text-slate-800">Notification Preferences</h3>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Choose which notification categories each staff member receives. A category with no
        override is enabled by default for everyone in Company Info's notification recipient list.
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 text-xs text-red-700">{error}</div>
      )}

      <div className="mb-4">
        <label className="block text-xs font-semibold text-slate-600 mb-1">Staff member</label>
        <select
          value={selectedEmail}
          onChange={(e) => setSelectedEmail(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 bg-white focus:outline-none focus:border-amber-500"
        >
          {users.map((u) => (
            <option key={u.email} value={u.email}>{u.full_name ? `${u.full_name} (${u.email})` : u.email}</option>
          ))}
        </select>
      </div>

      {loadingPrefs ? (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading preferences...</div>
      ) : (
        <div className="space-y-1.5">
          {(preferences || []).map((p) => (
            <label key={p.category} className="flex items-center justify-between gap-3 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-50">
              <span className="text-xs font-semibold text-slate-700">{CATEGORY_LABELS[p.category] || p.category}</span>
              <button
                type="button"
                disabled={readOnly || saving === p.category}
                onClick={() => toggleCategory(p.category, p.enabled)}
                className={`w-9 h-5 rounded-full relative transition-colors flex-shrink-0 disabled:opacity-50 ${p.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
                aria-pressed={p.enabled}
                aria-label={`${CATEGORY_LABELS[p.category] || p.category} notifications ${p.enabled ? 'enabled' : 'disabled'}`}
              >
                {saving === p.category ? (
                  <Loader2 className="w-3 h-3 animate-spin text-white absolute top-1 left-1" />
                ) : (
                  <span className={`block w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform ${p.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                )}
              </button>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
