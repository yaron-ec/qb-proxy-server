import { useState, useEffect } from "react";
import * as railwayTasks from "@/api/railway/tasks";
import { railwayRequest } from "@/lib/railwayClient";
import { ExternalLink, CheckCircle } from "lucide-react";

export default function MeetingsPanel({ lead }) {
  const clientName = `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim();
  const address = [lead?.property_address, lead?.city].filter(Boolean).join(", ");
  const projectType = lead?.project_type || "";
  const budget = lead?.budget_range || "";

  const [meetingTitle, setMeetingTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("120");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [eventLink, setEventLink] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const title = [clientName, projectType].filter(Boolean).join(" – ");
    if (title) setMeetingTitle(title);
  }, [clientName, projectType]);

  const timeSlots = [];
  for (let h = 8; h <= 19; h++) {
    ["00", "30"].forEach(m => {
      if (h === 19 && m === "30") return;
      const hh = String(h).padStart(2, "0");
      const label = `${h > 12 ? h - 12 : h}:${m} ${h >= 12 ? "PM" : "AM"}`;
      timeSlots.push({ value: `${hh}:${m}`, label });
    });
  }

  const durationOptions = [
    { value: "60", label: "1 hour" },
    { value: "90", label: "1.5 hours" },
    { value: "120", label: "2 hours" },
    { value: "150", label: "2.5 hours" },
    { value: "180", label: "3 hours" },
  ];

  const autoNotes = [
    clientName && `Client: ${clientName}`,
    lead?.phone && `Phone: ${lead.phone}`,
    lead?.email && `Email: ${lead.email}`,
    address && `Address: ${address}`,
    projectType && `Project: ${projectType}`,
    budget && `Budget: ${budget}`,
    lead?.scope_details && `Scope: ${lead.scope_details}`,
    lead?.main_goals && `Goals: ${lead.main_goals}`,
  ].filter(Boolean).join("\n");

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    // Save as task
    await railwayTasks.create({
      lead_id: lead.id,
      title: meetingTitle || "Meeting",
      notes: autoNotes,
      due_date: date,
      due_time: time,
      completed: false,
    });

    // Save to Google Calendar via Railway
    try {
      const calData = await railwayRequest('/calendar/create-event', {
        title: meetingTitle || "Meeting",
        date,
        time,
        durationMinutes: Number(duration),
        description: autoNotes,
        attendeeEmail: lead?.email,
      });
      if (calData?.eventLink) setEventLink(calData.eventLink);
      else if (calData?.error) setError(calData.error);
    } catch (e) {
      setError(e.message || 'Calendar event creation failed');
    }

    setSaved(true);
    setSaving(false);
  };

  return (
    <div className="p-4 space-y-3">
      {saved ? (
        <div className="text-center py-6">
          <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-2">
            <CheckCircle className="w-5 h-5 text-emerald-600" />
          </div>
          <p className="text-sm font-semibold text-slate-700">Appointment saved!</p>
          {eventLink && (
            <a href={eventLink} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline mt-2">
              <ExternalLink className="w-3 h-3" />
              Open in Google Calendar
            </a>
          )}
          {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
          <button onClick={() => { setSaved(false); setEventLink(null); setError(null); setDate(""); setTime(""); }}
            className="block text-xs text-blue-600 hover:underline mt-2 mx-auto">Schedule another</button>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Meeting Title</label>
            <input
              type="text"
              placeholder="e.g., Initial Consultation"
              className="w-full border border-slate-200 rounded px-3 py-2 text-sm text-slate-800 font-medium focus:outline-none focus:border-blue-400"
              value={meetingTitle}
              onChange={e => setMeetingTitle(e.target.value)}
            />
          </div>

          {/* Auto-filled client info */}
          <div className="bg-blue-50 border border-blue-100 rounded p-3 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-2">Auto-filled Info</div>
            {clientName && (
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 w-16 flex-shrink-0">Client</span>
                <span className="font-semibold text-slate-800">{clientName}</span>
              </div>
            )}
            {address && (
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 w-16 flex-shrink-0">Address</span>
                <span className="font-semibold text-slate-800">{address}</span>
              </div>
            )}
            {projectType && (
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 w-16 flex-shrink-0">Project</span>
                <span className="font-semibold text-slate-800">{projectType}</span>
              </div>
            )}
            {budget && (
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 w-16 flex-shrink-0">Budget</span>
                <span className="font-semibold text-slate-800">{budget}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Date</label>
              <input type="date" className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Time</label>
              <select className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 bg-white text-slate-800"
                value={time} onChange={e => setTime(e.target.value)}>
                <option value="">Select time...</option>
                {timeSlots.map(slot => (
                  <option key={slot.value} value={slot.value}>{slot.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Duration</label>
            <select className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 bg-white text-slate-800"
              value={duration} onChange={e => setDuration(e.target.value)}>
              {durationOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSave}
            disabled={saving || !date}
            className="w-full bg-orange text-white px-3 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? (
              <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</>
            ) : (
              "Save & Add to Google Calendar"
            )}
          </button>
        </>
      )}
    </div>
  );
}