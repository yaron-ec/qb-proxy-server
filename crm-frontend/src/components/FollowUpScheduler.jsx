import { useState } from "react";
import { leads as railwayLeads } from "@/api/railway";
import { Phone, MessageSquare, Mail, Calendar, ListTodo, AlertTriangle, Pencil, X, CheckCircle2 } from "lucide-react";

// Mirrors lib/followUp.js FOLLOW_UP_TYPES (server is authoritative).
const FOLLOW_UP_TYPES = ["Phone Call", "Text", "Email", "Meeting", "Other"];
const TYPE_ICON = { "Phone Call": Phone, Text: MessageSquare, Email: Mail, Meeting: Calendar, Other: ListTodo };

function fmt12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// PRODUCT CORRECTION (November 2026): the Follow-Up fields are the single
// user-facing source of scheduling truth for a Meeting. Saving a Meeting
// Follow-Up's date/time here now automatically creates/reschedules the
// real appointment, updates Google Calendar, and keeps reminders correct
// (lib/booking/followUpAppointmentSync.js, wired into PUT /:id/follow-up
// on the server) — never a separate "Reschedule" or "Promote" step. This
// supersedes the prior design (a warning + an admin-only Promote button)
// that treated the Appointment as a second, independent source of truth.
//
// The ONE remaining case this banner still surfaces: the server's
// automatic sync deliberately leaves an active appointment untouched when
// it does NOT match what THIS follow-up held just before the edit — e.g.
// an appointment booked independently through the Appointment editor,
// unrelated to this follow-up. That's a genuine "these two don't look
// like the same thing" situation a human should glance at; it is never
// auto-merged or auto-cancelled. lead.follow_up_appointment_mismatch is
// server-computed and read-only — it is simply absent whenever the
// automatic sync already resolved things, which is the common case.
function MismatchNotice({ lead }) {
  return (
    <div className="mt-2 flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-amber-800">
        This follow-up doesn't match the active Appointment ({fmtDate(lead.appointment_date)}
        {lead.appointment_time ? ` • ${fmt12(lead.appointment_time)}` : ""}) — since they don't look like the
        same event, the appointment was left as-is. If this follow-up is meant to represent that appointment,
        review it in the Appointment section above.
      </p>
    </div>
  );
}

function SyncResultNotice({ result }) {
  if (!result || result.action === 'none' || result.action === 'skipped_unrelated') return null;
  if (result.action === 'error') {
    return (
      <div className="mt-2 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
        <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-red-700">
          Follow-up saved, but the appointment could not be updated automatically: {result.error?.message || "unknown error"}. Please check the Appointment section above.
        </p>
      </div>
    );
  }
  const label = { created: "An appointment was created to match.", rescheduled: "The appointment was rescheduled to match.", cancelled: "The appointment was cancelled to match." }[result.action];
  if (!label) return null;
  return (
    <div className="mt-2 flex items-start gap-1.5 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-2">
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-emerald-800">{label}</p>
    </div>
  );
}

/**
 * FollowUpScheduler — Lead Detail → Schedule → Follow-up / Next Update.
 *
 * Writes through PUT /api/v1/leads/:id/follow-up. For a Meeting with a
 * date, the server automatically keeps the real appointment, Google
 * Calendar, and reminders in sync — see the module header above.
 */
export default function FollowUpScheduler({ lead, onLeadUpdate }) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(lead.follow_up_date || "");
  const [time, setTime] = useState(lead.follow_up_time || "");
  const [type, setType] = useState(lead.follow_up_type || "");
  const [notes, setNotes] = useState(lead.follow_up_notes || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [lastSyncResult, setLastSyncResult] = useState(null);

  const typeOptions = lead.follow_up_type && !FOLLOW_UP_TYPES.includes(lead.follow_up_type)
    ? [...FOLLOW_UP_TYPES, lead.follow_up_type] : FOLLOW_UP_TYPES;
  const status = lead.follow_up_status || (lead.follow_up_date ? "pending" : null);
  const savedMismatch = lead.follow_up_appointment_mismatch;

  const send = async (body) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await railwayLeads.updateFollowUp(lead.id, body, { signal: controller.signal });
      if (!res?.lead) throw new Error("The server did not return the updated lead.");
      onLeadUpdate(res.lead);
      setLastSyncResult(res.follow_up_appointment_sync || null);
      return true;
    } catch (e) {
      setSaveError(e?.name === "AbortError"
        ? "The server took too long to respond. Nothing was changed — please try again."
        : (e?.data?.message || e?.message || "Failed to save the follow-up."));
      return false;
    } finally {
      clearTimeout(timeoutId);
      setSaving(false);
    }
  };

  const startEdit = () => {
    setDate(lead.follow_up_date || "");
    setTime(lead.follow_up_time || "");
    setType(lead.follow_up_type || "");
    setNotes(lead.follow_up_notes || "");
    setSaveError(null);
    setLastSyncResult(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!date || !type) { setSaveError("A follow-up needs a date and a type."); return; }
    const ok = await send({
      follow_up_date: date,
      follow_up_time: time || null,
      follow_up_type: type,
      follow_up_notes: notes.trim() || null,
      follow_up_status: "pending",
    });
    if (ok) setEditing(false);
  };

  const handleClear = async () => {
    const ok = await send({ follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_notes: null, follow_up_status: null });
    if (ok) setEditing(false);
  };

  const toggleDone = () => send({ follow_up_status: status === "completed" ? "pending" : "completed" });

  const errorBox = saveError && (
    <div className="mt-2 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
      <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-red-700">{saveError}</p>
    </div>
  );

  if (!editing) {
    const Icon = TYPE_ICON[lead.follow_up_type] || ListTodo;
    return (
      <div data-testid="follow-up-editor">
        <div className="flex items-center justify-between mb-2">
          <p className="sidebar-section-header">Follow-up / Next Update</p>
          <button onClick={startEdit} className="text-[10px] text-amber-600 hover:text-amber-700 font-semibold flex items-center gap-1">
            <Pencil className="w-3 h-3" /> {lead.follow_up_date ? "Edit" : "Add"}
          </button>
        </div>
        {lead.follow_up_date ? (
          <div className={`rounded-lg border px-3 py-2 space-y-1 ${status === "completed" ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
            <div className="flex items-center gap-2">
              <Icon className="w-3.5 h-3.5 text-slate-500" />
              <span className={`text-xs font-semibold ${status === "completed" ? "text-emerald-700 line-through" : "text-slate-800"}`}>
                {lead.follow_up_type || "Follow-up"}
              </span>
              <button onClick={toggleDone} disabled={saving}
                className={`ml-auto text-[10px] font-semibold flex items-center gap-0.5 ${status === "completed" ? "text-emerald-700" : "text-slate-500 hover:text-emerald-700"}`}>
                <CheckCircle2 className="w-3 h-3" /> {status === "completed" ? "Done" : "Mark done"}
              </button>
            </div>
            <p className="text-xs text-slate-600" data-testid="follow-up-when">
              {new Date(lead.follow_up_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {lead.follow_up_time ? ` • ${fmt12(lead.follow_up_time)}` : ""}
            </p>
            {lead.follow_up_type === "Meeting" && (
              <p className="text-[10px] text-slate-400">Keeps the appointment, Google Calendar, and reminders in sync automatically.</p>
            )}
            {lead.follow_up_notes && <p className="text-[11px] text-slate-500 whitespace-pre-wrap">{lead.follow_up_notes}</p>}
          </div>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
        <SyncResultNotice result={lastSyncResult} />
        {savedMismatch && status !== "completed" && <MismatchNotice lead={lead} />}
        {errorBox}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="follow-up-editor">
      <div className="flex items-center justify-between">
        <p className="sidebar-section-header">{lead.follow_up_date ? "Update Follow-up" : "Add Follow-up"}</p>
        <button onClick={() => setEditing(false)} aria-label="Cancel edit" className="text-slate-400 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Follow-up date"
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Time</label>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} aria-label="Follow-up time"
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500" />
        </div>
      </div>
      <div>
        <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Type</label>
        <select value={type} onChange={e => setType(e.target.value)} aria-label="Follow-up type"
          className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500">
          <option value="">Select type…</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className="text-[10px] font-semibold text-slate-500 uppercase block mb-1">Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={2000} aria-label="Follow-up notes"
          placeholder="What should happen next?"
          className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500" />
      </div>
      {type === "Meeting" ? (
        <p className="text-[10px] text-slate-400">Saving this keeps the real appointment, Google Calendar, and reminders in sync automatically — no separate scheduling step needed.</p>
      ) : (
        <p className="text-[10px] text-slate-400">Follow-ups are internal reminders — they don't book a visit or block your calendar (you'll see a free reminder on your Google Calendar).</p>
      )}
      {errorBox}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !date || !type}
          className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded transition-colors">
          {saving ? "Saving..." : lead.follow_up_date ? "Update" : "Save"}
        </button>
        {lead.follow_up_date && (
          <button onClick={handleClear} disabled={saving}
            className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors">
            Clear
          </button>
        )}
        <button onClick={() => setEditing(false)}
          className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
