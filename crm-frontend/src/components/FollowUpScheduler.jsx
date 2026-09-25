import { useState } from "react";
import { leads as railwayLeads } from "@/api/railway";
import { Phone, MessageSquare, Mail, Calendar, ListTodo, AlertTriangle, Pencil, X, CheckCircle2 } from "lucide-react";

// Mirrors lib/followUp.js FOLLOW_UP_TYPES (server is authoritative). A
// 'Meeting' follow-up is still only a follow-up: it never creates an
// appointment, blocks availability, or touches Google Calendar/reminders. A
// customer visit is booked as the Appointment.
const FOLLOW_UP_TYPES = ["Phone Call", "Text", "Email", "Meeting", "Other"];
const TYPE_ICON = { "Phone Call": Phone, Text: MessageSquare, Email: Mail, Meeting: Calendar, Other: ListTodo };

function fmt12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * FollowUpScheduler — Lead Detail → Schedule → Follow-up / Next Update.
 *
 * Reads and writes ONLY the follow-up (leads.follow_up_date / _time / _type /
 * _notes / _status) through PUT /api/v1/leads/:id/follow-up. A follow-up never
 * creates, moves or cancels the appointment and never touches Google Calendar
 * (the appointment has its own editor: AppointmentEditor).
 */
export default function FollowUpScheduler({ lead, onLeadUpdate }) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(lead.follow_up_date || "");
  const [time, setTime] = useState(lead.follow_up_time || "");
  const [type, setType] = useState(lead.follow_up_type || "");
  const [notes, setNotes] = useState(lead.follow_up_notes || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const typeOptions = lead.follow_up_type && !FOLLOW_UP_TYPES.includes(lead.follow_up_type)
    ? [...FOLLOW_UP_TYPES, lead.follow_up_type] : FOLLOW_UP_TYPES;
  const status = lead.follow_up_status || (lead.follow_up_date ? "pending" : null);

  const send = async (body) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await railwayLeads.updateFollowUp(lead.id, body, { signal: controller.signal });
      if (!res?.lead) throw new Error("The server did not return the updated lead.");
      onLeadUpdate(res.lead);
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
            {lead.follow_up_notes && <p className="text-[11px] text-slate-500 whitespace-pre-wrap">{lead.follow_up_notes}</p>}
          </div>
        ) : (
          <p className="text-sm text-slate-400">—</p>
        )}
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
      <p className="text-[10px] text-slate-400">Follow-ups are internal reminders — they don't book a visit or add a Google Calendar event.</p>
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
