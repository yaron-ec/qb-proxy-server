import { useState, useEffect, useRef } from "react";
import { leads as railwayLeads } from "@/api/railway";
import { useAuth } from "@/lib/AuthContext";
import { resolveOwnerEmail } from "@/lib/ownerEmailMap";
import { validateSlot } from "@/lib/calendarAvailability";
import { Calendar, Phone, AlertTriangle, Pencil, X, ShieldAlert, Loader2, RefreshCw } from "lucide-react";
import AvailableTimePicker from "@/components/AvailableTimePicker";

// Server-side allowlist is authoritative; this mirror only gates the UI.
const ADMIN_OVERRIDE_EMAILS = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];
const POLL_MS = 5000;
const POLL_MAX_MS = 2 * 60 * 1000;

function fmt12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * AppointmentEditor — Lead Detail → Schedule → Appointment.
 *
 * Reads ONLY lead.appointment (the canonical appointments row serialized by
 * the API) and writes ONLY through PUT /api/v1/leads/:id/appointment, which
 * books / reschedules / cancels via lib/booking/bookingService (conflict +
 * travel-buffer rules, Google Calendar outbox, reminder projection in one
 * transaction). The Follow-Up is a separate editor (FollowUpScheduler) and is
 * never read or written here.
 *
 * Calendar status comes from the same row: pending → "Syncing…" (polled until
 * it resolves), retrying/failed → the worker's error is shown with a Retry.
 */
export default function AppointmentEditor({ lead, onLeadUpdate }) {
  const appt = lead.appointment || null;
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(appt?.date || "");
  const [time, setTime] = useState(appt?.time || "");
  const [kind, setKind] = useState(appt?.kind || "Meeting");
  const [saving, setSaving] = useState(false);
  const [availabilityError, setAvailabilityError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { user: authUser } = useAuth();
  const pollStart = useRef(null);

  const isAdminUser = !!authUser && (authUser.role === 'admin'
    || ADMIN_OVERRIDE_EMAILS.includes((authUser.email || '').toLowerCase()));
  const syncStatus = appt?.calendar_sync_status || null;

  // Poll the lead while the calendar sync is unresolved so the UI never sits
  // on "Syncing…" — it flips to synced / retrying / failed as the worker runs.
  useEffect(() => {
    if (!appt || (syncStatus !== 'pending' && syncStatus !== 'retrying')) {
      pollStart.current = null;
      setPollExpired(false);
      return undefined;
    }
    if (!pollStart.current) pollStart.current = Date.now();
    if (Date.now() - pollStart.current > POLL_MAX_MS) { setPollExpired(true); return undefined; }
    const t = setTimeout(async () => {
      try {
        const res = await railwayLeads.get(lead.id);
        if (res?.lead) onLeadUpdate(res.lead);
      } catch { /* next tick retries; errors surface via status */ }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [appt?.id, syncStatus, lead, onLeadUpdate]);

  const clientName = `${lead.first_name || ""} ${lead.last_name || ""}`.trim();

  const startEdit = () => {
    setDate(appt?.date || "");
    setTime(appt?.time || "");
    setKind(appt?.kind || "Meeting");
    setAvailabilityError(null);
    setSaveError(null);
    setOverrideEnabled(false);
    setEditing(true);
  };

  const send = async (body) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await railwayLeads.updateAppointment(lead.id, body, { signal: controller.signal });
      if (!res?.lead) throw Object.assign(new Error("The server did not return the updated lead."), { status: 502 });
      onLeadUpdate(res.lead);
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const describeError = (e, fallback) => {
    if (e?.name === 'AbortError') return "The server took too long to respond. Nothing was changed — please try again.";
    return e?.data?.message || e?.message || fallback;
  };

  const handleSave = async () => {
    if (!date || !time) { setSaveError("Pick a date and a time."); return; }
    setSaving(true);
    setAvailabilityError(null);
    setSaveError(null);
    if (kind === "Meeting") {
      const [h, m] = time.split(":").map(Number);
      if (h < 8 || (h === 8 && m < 30)) {
        setAvailabilityError("Meetings can only be scheduled at 8:30 AM or later.");
        setSaving(false);
        return;
      }
    }
    // Client-side pre-check; the server re-checks under the owner-schedule lock.
    if (lead.assigned_rep && !(isAdminUser && overrideEnabled)) {
      try {
        const av = await validateSlot(date, time, lead.assigned_rep, { excludeAppointmentId: appt?.id });
        if (av?.blocked === true && kind === "Meeting") {
          setAvailabilityError(`This owner is not available at ${fmt12(time)} (including the 1-hour travel buffer). Please choose another time.`);
          setSaving(false);
          return;
        }
      } catch { /* backend is the source of truth */ }
    }
    try {
      await send({
        appointment_date: date,
        appointment_time: time,
        appointment_type: kind,
        admin_override: isAdminUser && overrideEnabled,
        expected_appointment_id: appt?.id || null,
      });
      setEditing(false);
    } catch (e) {
      const msg = describeError(e, "Failed to save the appointment.");
      if (e?.status === 409 && !(isAdminUser && overrideEnabled)) setAvailabilityError(msg);
      else setSaveError(msg);
      if (e?.status === 403 && e?.data?.error === 'override_forbidden') setOverrideEnabled(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancelAppointment = async () => {
    if (!appt) return;
    if (!window.confirm(`Cancel the ${appt.kind.toLowerCase()} on ${appt.date} at ${fmt12(appt.time)}? The Google Calendar event will be removed.`)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await send({ cancel: true, expected_appointment_id: appt.id });
      setEditing(false);
    } catch (e) {
      setSaveError(describeError(e, "Failed to cancel the appointment."));
    } finally {
      setSaving(false);
    }
  };

  const handleRetrySync = async () => {
    setRetrying(true);
    setSaveError(null);
    try {
      await railwayLeads.syncCalendar(lead.id);
      const res = await railwayLeads.get(lead.id);
      if (res?.lead) onLeadUpdate(res.lead);
      pollStart.current = null;
      setPollExpired(false);
    } catch (e) {
      setSaveError(describeError(e, "Could not re-queue the calendar sync."));
    } finally {
      setRetrying(false);
    }
  };

  const errorBox = (msg) => msg && (
    <div className="mt-2 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
      <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-red-700">{msg}</p>
    </div>
  );

  if (!editing) {
    return (
      <div data-testid="appointment-editor">
        <div className="flex items-center justify-between mb-2">
          <p className="sidebar-label">Appointment</p>
          <button onClick={startEdit} className="text-[10px] text-amber-600 hover:text-amber-700 font-semibold flex items-center gap-1">
            <Pencil className="w-3 h-3" /> {appt ? "Edit" : "Schedule"}
          </button>
        </div>
        {appt ? (
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 space-y-1">
            <div className="flex items-center gap-2">
              {appt.kind === "Phone Call"
                ? <Phone className="w-3.5 h-3.5 text-green-500" />
                : <Calendar className="w-3.5 h-3.5 text-blue-500" />}
              <span className="text-xs font-semibold text-slate-800">{appt.kind}</span>
            </div>
            <p className="text-xs text-slate-600" data-testid="appointment-when">
              {new Date(appt.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {` • ${fmt12(appt.time)}`}{appt.end_time ? `–${fmt12(appt.end_time)}` : ""}
            </p>
            {syncStatus === 'synced' && (
              <p className="text-[10px] text-emerald-600 font-semibold">✓ Synced to Google Calendar</p>
            )}
            {syncStatus === 'pending' && !pollExpired && (
              <p className="text-[10px] text-slate-500 font-medium flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Syncing to Google Calendar…
              </p>
            )}
            {syncStatus === 'pending' && pollExpired && (
              <p className="text-[10px] text-amber-700 font-semibold">
                ⚠ Calendar sync has not completed yet (queued).{" "}
                <button onClick={handleRetrySync} disabled={retrying} className="underline">Retry</button>
              </p>
            )}
            {syncStatus === 'retrying' && (
              <p className="text-[10px] text-amber-700 font-semibold">
                ⚠ Calendar sync failed, retrying automatically{appt.calendar_last_error ? `: ${appt.calendar_last_error}` : ""}
              </p>
            )}
            {syncStatus === 'failed' && (
              <p className="text-[10px] text-red-600 font-semibold">
                ⚠ Calendar sync failed{appt.calendar_last_error ? `: ${appt.calendar_last_error}` : ""}.{" "}
                <button onClick={handleRetrySync} disabled={retrying} className="underline inline-flex items-center gap-0.5">
                  <RefreshCw className={`w-3 h-3 ${retrying ? "animate-spin" : ""}`} /> Retry sync
                </button>
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm"><span className="sidebar-empty">Not set</span></p>
        )}
        {errorBox(saveError)}
      </div>
    );
  }

  const ownerEmail = resolveOwnerEmail(lead.assigned_rep);
  return (
    <div className="space-y-3" data-testid="appointment-editor">
      <div className="flex items-center justify-between">
        <p className="sidebar-label">{appt ? "Reschedule Appointment" : "Schedule Appointment"}</p>
        <button onClick={() => setEditing(false)} aria-label="Cancel edit" className="text-slate-400 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {["Meeting", "Phone Call"].map(k => (
          <button
            key={k}
            onClick={() => { setKind(k); setAvailabilityError(null); setOverrideEnabled(false); }}
            className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 text-xs font-semibold transition-colors ${
              kind === k
                ? (k === "Meeting" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-green-500 bg-green-50 text-green-700")
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            {k === "Meeting" ? <Calendar className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            {k === "Meeting" ? "Site Visit" : "Phone Call"}
          </button>
        ))}
      </div>

      <div>
        <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Date</label>
        <input
          type="date"
          value={date}
          onChange={e => { setDate(e.target.value); setAvailabilityError(null); setOverrideEnabled(false); }}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
        />
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <label className="text-[10px] font-semibold text-slate-500 uppercase">Time</label>
          {isAdminUser && (
            <button
              onClick={() => { setOverrideEnabled(!overrideEnabled); setAvailabilityError(null); }}
              className={`flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full transition-colors ${
                overrideEnabled ? 'text-white bg-amber-500 border border-amber-500' : 'text-amber-600 bg-amber-50 border border-amber-200 hover:bg-amber-100'}`}
            >
              <ShieldAlert className="w-2.5 h-2.5" /> Override {overrideEnabled ? 'ON' : 'OFF'}
            </button>
          )}
        </div>
        <AvailableTimePicker
          value={time}
          onChange={v => { setTime(v); setAvailabilityError(null); setOverrideEnabled(false); }}
          date={date}
          ownerName={lead.assigned_rep}
          adminOverride={isAdminUser && overrideEnabled}
          excludeAppointmentId={appt?.id}
        />
      </div>

      {errorBox(availabilityError)}
      {errorBox(saveError)}

      <div className={`${kind === "Meeting" ? "bg-blue-50 border-blue-200" : "bg-green-50 border-green-200"} border rounded-lg px-3 py-2.5 space-y-1`}>
        <p className={`text-[10px] font-semibold ${kind === "Meeting" ? "text-blue-800" : "text-green-800"}`}>
          Google Calendar event will be {appt ? "updated" : "created"} automatically:
        </p>
        <ul className={`text-[10px] ${kind === "Meeting" ? "text-blue-700" : "text-green-700"} list-disc list-inside space-y-0.5`}>
          <li>{time ? fmt12(time) : "Selected time"} — 1hr {kind === "Meeting" ? "meeting" : "phone call"} with {clientName}</li>
          {kind === "Meeting"
            ? <li>Calendar blocked 1hr before and 1hr after (travel)</li>
            : <li>No travel buffer (no driving needed)</li>}
          <li>Customer reminders: 12h, 2h, 30min before the start</li>
        </ul>
        {ownerEmail && <p className="text-[10px] text-slate-600">📋 Owner invite: {ownerEmail}</p>}
        {kind === "Meeting" && !lead.email && (
          <p className="text-[10px] text-amber-700">⚠ No client email — client invite will NOT be sent</p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !date || !time}
          className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded transition-colors"
        >
          {saving ? "Saving..." : appt ? "Update" : "Save"}
        </button>
        {appt && (
          <button
            onClick={handleCancelAppointment}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors"
          >
            Cancel appt
          </button>
        )}
        <button
          onClick={() => setEditing(false)}
          className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
