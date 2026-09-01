import { useState, useEffect } from "react";
import { leads as railwayLeads } from "@/api/railway";
import { useAuth } from "@/lib/AuthContext";
import { resolveOwnerEmail } from "@/lib/ownerEmailMap";
import { validateSlot } from "@/lib/calendarAvailability";
import { Calendar, Phone, AlertTriangle, Pencil, X, ShieldAlert, Loader2 } from "lucide-react";
import AvailableTimePicker from "@/components/AvailableTimePicker";

// Emails of users who are allowed to override booking conflicts
const ADMIN_OVERRIDE_EMAILS = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];

function fmt12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * FollowUpScheduler — frontend saves ONLY the appointment fields (follow_up_date,
 * follow_up_time, follow_up_type) to the Lead. Google Calendar event creation /
 * update / deletion is owned entirely by the `onLeadAppointmentChanged` backend
 * entity automation. This component reflects the backend's resulting sync status
 * (google_event_id / google_calendar_sync_status) via a realtime subscription so
 * the user sees the calendar event appear within a couple seconds, with no
 * blocking "Syncing…" spinner.
 */
export default function FollowUpScheduler({ lead, onLeadUpdate }) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(lead.follow_up_date || "");
  const [time, setTime] = useState(lead.follow_up_time || "");
  const [type, setType] = useState(lead.follow_up_type || "");
  const [saving, setSaving] = useState(false);
  const [availabilityError, setAvailabilityError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const { user: authUser } = useAuth();

  // Check admin override from auth context
  useEffect(() => {
    if (authUser) {
      const email = (authUser.email || '').toLowerCase();
      const role = authUser.role || '';
      const byRole = ['admin', 'owner', 'manager'].includes(role);
      const byEmail = ADMIN_OVERRIDE_EMAILS.includes(email);
      setIsAdminUser(byRole || byEmail);
    }
  }, [authUser]);

  // Auto-clear "justSaved" after 12s (realtime subscription removed — Railway
  // has no client-side subscribe; the parent LeadDetailModern polls on save).
  useEffect(() => {
    if (!justSaved) return;
    const timeout = setTimeout(() => setJustSaved(false), 12000);
    return () => clearTimeout(timeout);
  }, [justSaved]);

  const clientName = `${lead.first_name || ""} ${lead.last_name || ""}`.trim();
  const hasEmail = !!lead.email;

  const handleSave = async () => {
    if (!date) return;
    setSaving(true);
    setAvailabilityError(null);
    setSaveError(null);

    // Enforce 8:30 AM minimum for Meetings
    if (type === "Meeting" && time) {
      const [h, m] = time.split(":").map(Number);
      if (h < 8 || (h === 8 && m < 30)) {
        setAvailabilityError("Meetings can only be scheduled at 8:30 AM or later.");
        setSaving(false);
        return;
      }
    }

    // Client-side availability check for Meeting type (admin may override)
    if (type === "Meeting" && time && lead.assigned_rep) {
      try {
        const avData = await validateSlot(date, time, lead.assigned_rep);
        if (avData?.blocked === true && !isAdminUser) {
          setAvailabilityError(`This owner is not available at ${fmt12(time)}. Please select a different time.`);
          setSaving(false);
          return;
        }
      } catch {
        // Availability check failed — proceed with saving (backend is source of truth)
      }
    }

    // AbortController timeout — prevents the fetch from hanging indefinitely
    // if the backend is unreachable or the connection stalls. Without this,
    // the "Saving..." state can persist forever.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await railwayLeads.updateAppointmentByExternal(lead.id, {
        follow_up_date: date,
        follow_up_time: time || null,
        follow_up_type: type || null,
      }, { signal: controller.signal });
      // Preserve the identifier contract: lead.id = external_ref || url_id,
      // lead.railway_id = Railway UUID. The raw API response has id = Railway UUID,
      // so we must transform it the same way LeadDetailModern does.
      if (res?.lead) {
        const r = res.lead;
        r.railway_id = r.id;
        r.id = r.external_ref || lead.id;
        onLeadUpdate(r);
      }
      setJustSaved(true);
      setEditing(false);
    } catch (e) {
      if (e?.name === 'AbortError') {
        setSaveError("The server took too long to respond. Please try again.");
      } else {
        const msg = e?.data?.message || e?.message || "Failed to save appointment.";
        if (e?.status === 409) {
          setAvailabilityError(msg);
        } else {
          setSaveError(msg);
        }
      }
    } finally {
      clearTimeout(timeoutId);
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setSaveError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await railwayLeads.updateAppointmentByExternal(lead.id, {
        follow_up_date: null,
        follow_up_time: null,
        follow_up_type: null,
      }, { signal: controller.signal });
      if (res?.lead) {
        const r = res.lead;
        r.railway_id = r.id;
        r.id = r.external_ref || lead.id;
        onLeadUpdate(r);
      }
      setDate("");
      setTime("");
      setType("");
      setJustSaved(true);
    } catch (e) {
      if (e?.name === 'AbortError') {
        setSaveError("The server took too long to respond. Please try again.");
      } else {
        const msg = e?.data?.message || e?.message || "Failed to clear appointment.";
        setSaveError(msg);
      }
    } finally {
      clearTimeout(timeoutId);
      setSaving(false);
    }
  };

  const syncStatus = lead.google_calendar_sync_status;
  const showSyncingPill = justSaved && type === "Meeting" && !lead.google_event_id && syncStatus !== 'error';

  // Display (not editing)
  if (!editing) {
    const hasFollowUp = lead.follow_up_date;
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="sidebar-section-header">Follow-up</p>
          <button
            onClick={() => {
              setDate(lead.follow_up_date || "");
              setTime(lead.follow_up_time || "");
              setType(lead.follow_up_type || "");
              setJustSaved(false);
              setAvailabilityError(null);
              setSaveError(null);
              setEditing(true);
            }}
            className="text-[10px] text-amber-600 hover:text-amber-700 font-semibold flex items-center gap-1"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        </div>

        {hasFollowUp ? (
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 space-y-1">
            <div className="flex items-center gap-2">
              {lead.follow_up_type === "Meeting" ? (
                <Calendar className="w-3.5 h-3.5 text-blue-500" />
              ) : (
                <Phone className="w-3.5 h-3.5 text-green-500" />
              )}
              <span className="text-xs font-semibold text-slate-800">
                {lead.follow_up_type || "Follow-up"}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {lead.follow_up_date
                ? new Date(lead.follow_up_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : ""}
              {lead.follow_up_time ? ` • ${fmt12(lead.follow_up_time)}` : ""}
            </p>
            {lead.follow_up_type === "Meeting" && lead.google_event_id && (
              <p className="text-[10px] text-emerald-600 font-semibold">✓ Synced to Google Calendar</p>
            )}
            {showSyncingPill && (
              <p className="text-[10px] text-slate-500 font-medium flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Syncing to Google Calendar…
              </p>
            )}
            {lead.follow_up_type === "Meeting" && syncStatus === 'error' && (
              <p className="text-[10px] text-red-600 font-semibold">⚠ Calendar sync failed — retry from Integrations</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}

        {availabilityError && (
          <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-red-700">{availabilityError}</p>
          </div>
        )}
        {saveError && (
          <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-red-700">{saveError}</p>
          </div>
        )}
      </div>
    );
  }

  // Editing mode
  const ownerEmail = resolveOwnerEmail(lead.assigned_rep);
  const isUpdate = !!(lead.follow_up_date || lead.google_event_id);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="sidebar-section-header">
          {isUpdate ? "Update Follow-up" : "Schedule Follow-up"}
        </p>
        <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Date */}
      <div>
        <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Date</label>
        <input
          type="date"
          value={date}
          onChange={e => { setDate(e.target.value); setAvailabilityError(null); }}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
        />
      </div>

      {/* Time */}
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label className="text-[10px] font-semibold text-slate-500 uppercase">Time</label>
          {isAdminUser && (
            <span className="flex items-center gap-0.5 text-[9px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
              <ShieldAlert className="w-2.5 h-2.5" /> Admin Override
            </span>
          )}
        </div>
        <AvailableTimePicker
          value={time}
          onChange={v => { setTime(v); setAvailabilityError(null); }}
          date={date}
          ownerName={lead.assigned_rep}
          adminOverride={isAdminUser}
        />
      </div>

      {availabilityError && (
        <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-700">{availabilityError}</p>
        </div>
      )}

      {saveError && (
        <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-700">{saveError}</p>
        </div>
      )}

      {/* Type */}
      {date && (
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-2">Type</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { setType("Phone Call"); setAvailabilityError(null); }}
              className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border-2 text-xs font-semibold transition-colors ${
                type === "Phone Call"
                  ? "border-green-500 bg-green-50 text-green-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              <Phone className="w-4 h-4" />
              Phone Call
            </button>
            <button
              onClick={() => { setType("Meeting"); setAvailabilityError(null); }}
              className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border-2 text-xs font-semibold transition-colors ${
                type === "Meeting"
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              <Calendar className="w-4 h-4" />
              Meeting
            </button>
          </div>
        </div>
      )}

      {/* Meeting info box */}
      {type === "Meeting" && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 space-y-1">
          <p className="text-[10px] font-semibold text-blue-800">
            {isUpdate ? "Google Calendar event will be updated automatically:" : "Google Calendar event will be created automatically:"}
          </p>
          <p className="text-[10px] text-blue-600 font-medium">⏰ Available times: 8:30 AM – 6:30 PM</p>
          <ul className="text-[10px] text-blue-700 list-disc list-inside space-y-0.5">
            <li>{time ? fmt12(time) : "Selected time"} — 1hr meeting with {clientName}</li>
            <li>+1hr: Driving / Travel Time (busy, no client invite)</li>
            <li>Reminders: 48h, 24h, 12h, 2h, 30min (email)</li>
          </ul>
          {ownerEmail && (
            <p className="text-[10px] text-blue-600">📋 Owner invite: {ownerEmail}</p>
          )}
          {!hasEmail && (
            <div className="flex items-center gap-1.5 mt-1 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" />
              <p className="text-[10px] text-amber-700">No client email — client invite will NOT be sent</p>
            </div>
          )}
        </div>
      )}

      {/* Phone Call info */}
      {type === "Phone Call" && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          <p className="text-[10px] text-green-700">CRM reminder only — no Google Calendar event.</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !date}
          className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded transition-colors"
        >
          {saving ? "Saving..." : isUpdate ? "Update" : "Save"}
        </button>
        {lead.follow_up_date && (
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors"
          >
            Clear
          </button>
        )}
        <button
          onClick={() => setEditing(false)}
          className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}