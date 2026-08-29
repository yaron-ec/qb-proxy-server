/**
 * MeetingPipelineAudit
 *
 * Admin diagnostic panel: traces the full pipeline for every lead with a
 * future (or same-day) Meeting appointment.
 *
 * Pipeline steps per lead:
 *  1. Lead Created
 *  2. Follow-up / Appointment Set
 *  3. Meeting Type = Meeting
 *  4. Google Calendar Event Created
 *  5. Travel Buffer Event Created
 *  6. Reminder windows (48h, 24h, 12h, 2h, 30min) — sent or pending
 *
 * Also provides a "Fix All" button that re-runs calendar sync for any lead
 * missing events.
 */
import { useState, useEffect } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayActivities from "@/api/railway/activities";
import {
  CheckCircle, XCircle, Clock, RefreshCw, AlertTriangle,
  Calendar, Zap, ChevronDown, ChevronRight, Bell
} from "lucide-react";

const REMINDER_WINDOWS = ['48h', '24h', '12h', '2h', '30min'];

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles"
  });
}

function fmtDate(d) {
  if (!d) return "—";
  const [y, mo, day] = d.split("-").map(Number);
  return new Date(y, mo - 1, day).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  });
}

function Step({ ok, label, detail, warn }) {
  const icon = ok === true
    ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
    : ok === "warn"
    ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
    : ok === null
    ? <Clock className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />
    : <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;

  return (
    <div className="flex items-start gap-1.5 py-0.5">
      {icon}
      <div className="min-w-0">
        <span className={`text-[11px] font-semibold ${
          ok === true ? "text-emerald-700" :
          ok === "warn" ? "text-amber-700" :
          ok === null ? "text-slate-400" :
          "text-red-700"
        }`}>{label}</span>
        {detail && <span className="text-[10px] text-slate-400 ml-1">{detail}</span>}
      </div>
    </div>
  );
}

function LeadRow({ lead, sentKeys, onFix, fixing }) {
  const [open, setOpen] = useState(false);

  const apptDate = lead.appointment_date || lead.follow_up_date;
  const apptTime = lead.appointment_time || lead.follow_up_time || "09:00";
  const isMeeting = lead.follow_up_type === "Meeting";
  const hasCalEvent = !!lead.google_event_id;
  const hasBuffer = !!lead.google_travel_event_id;
  const syncStatus = lead.google_calendar_sync_status;
  const syncError = lead.google_calendar_sync_error;

  // Reminder state
  const reminderState = {};
  for (const win of REMINDER_WINDOWS) {
    const key = `reminder:${lead.id}:${win}:${apptDate}`;
    reminderState[win] = sentKeys.has(key) ? "sent" : "pending";
  }

  // Compute appointment UTC ms for comparison
  function pacificToUtcMs(dateStr, timeStr) {
    try {
      const probe = new Date(`${dateStr}T12:00:00Z`);
      const laHour = Number(new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
      }).format(probe));
      const [y, mo, d] = dateStr.split("-").map(Number);
      const [h, m] = (timeStr || "09:00").split(":").map(Number);
      return Date.UTC(y, mo - 1, d, h - (laHour - 12), m, 0);
    } catch { return 0; }
  }

  const apptMs = apptDate ? pacificToUtcMs(apptDate, apptTime) : 0;
  const now = Date.now();
  const isPast = apptMs < now;
  const minsUntil = Math.round((apptMs - now) / 60000);

  // Which reminder windows are expected to have fired by now?
  const WINDOW_MINS = { "48h": 2880, "24h": 1440, "12h": 720, "2h": 120, "30min": 30 };
  const expectedSent = REMINDER_WINDOWS.filter(win => {
    const targetMs = apptMs - WINDOW_MINS[win] * 60 * 1000;
    return targetMs <= now;
  });
  const missedReminders = expectedSent.filter(win => reminderState[win] === "pending");

  // Overall status
  const hasCriticalIssue = !hasCalEvent || !hasBuffer || missedReminders.length > 0;
  const hasSyncError = syncStatus === "error";
  const overallOk = !hasCriticalIssue && !hasSyncError;

  const statusColor = hasSyncError || (!hasCalEvent && !isPast) ? "border-red-200 bg-red-50/40" :
    hasCriticalIssue ? "border-amber-200 bg-amber-50/30" :
    "border-emerald-200 bg-emerald-50/20";

  const statusIcon = hasSyncError || (!hasCalEvent && !isPast)
    ? <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
    : hasCriticalIssue
    ? <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
    : <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />;

  return (
    <div className={`border rounded-lg mb-2 overflow-hidden ${statusColor}`}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {statusIcon}
        <div className="flex-1 min-w-0">
          <span className="text-xs font-bold text-slate-800">
            {lead.first_name} {lead.last_name}
          </span>
          <span className="text-[10px] text-slate-500 ml-2">
            {fmtDate(apptDate)} {apptTime} · {lead.assigned_rep || "No rep"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px]">
          {isPast ? (
            <span className="text-slate-400">past</span>
          ) : (
            <span className="text-slate-500">{minsUntil >= 60 ? `${Math.round(minsUntil/60)}h` : `${minsUntil}m`} away</span>
          )}
          {!hasCalEvent && !isPast && (
            <button
              onClick={e => { e.stopPropagation(); onFix(lead); }}
              disabled={fixing}
              className="flex items-center gap-0.5 px-2 py-0.5 rounded border border-amber-400 bg-amber-50 text-amber-700 font-bold hover:bg-amber-100 transition-colors disabled:opacity-50"
            >
              {fixing ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Zap className="w-2.5 h-2.5" />}
              Fix
            </button>
          )}
        </div>
        {open ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />}
      </button>

      {open && (
        <div className="px-4 pb-3 border-t border-slate-100">
          <div className="grid grid-cols-2 gap-x-6 gap-y-0 mt-2">
            {/* Left: pipeline steps */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Pipeline</div>
              <Step ok={true} label="Lead Created" detail={fmt(lead.created_date)} />
              <Step ok={!!apptDate} label="Appointment Set" detail={apptDate ? `${fmtDate(apptDate)} ${apptTime}` : "missing"} />
              <Step ok={isMeeting} label="Meeting Type" detail={lead.follow_up_type || "not set"} />
              <Step
                ok={hasCalEvent ? true : (syncStatus === "error" ? false : null)}
                label="Google Calendar Event"
                detail={hasCalEvent ? lead.google_event_id?.slice(0, 12) + "…" : (syncStatus === "error" ? "error" : "not created")}
              />
              <Step
                ok={hasBuffer ? true : (hasCalEvent ? "warn" : null)}
                label="Travel Buffer"
                detail={hasBuffer ? lead.google_travel_event_id?.slice(0, 12) + "…" : "missing"}
              />
              {syncError && (
                <div className="mt-1 text-[10px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                  ⚠ {syncError}
                </div>
              )}
            </div>

            {/* Right: reminder windows */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Reminders</div>
              {REMINDER_WINDOWS.map(win => {
                const targetMs = apptMs - WINDOW_MINS[win] * 60 * 1000;
                const shouldHaveFired = targetMs <= now;
                const hasFired = reminderState[win] === "sent";
                const isMissed = shouldHaveFired && !hasFired;
                return (
                  <Step
                    key={win}
                    ok={hasFired ? true : isMissed ? false : null}
                    label={`${win} reminder`}
                    detail={hasFired ? "sent" : isMissed ? "MISSED" : "pending"}
                  />
                );
              })}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <a
              href={`/leads/${lead.id}`}
              className="text-[10px] font-semibold text-blue-600 hover:underline"
              target="_blank" rel="noreferrer"
            >
              Open Lead →
            </a>
            {lead.google_event_id && (
              <span className="text-[10px] text-slate-400">Cal ID: {lead.google_event_id}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MeetingPipelineAudit() {
  const [leads, setLeads] = useState([]);
  const [sentKeys, setSentKeys] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [fixingId, setFixingId] = useState(null);
  const [fixMsg, setFixMsg] = useState(null);
  const [filter, setFilter] = useState("issues");

  const load = async () => {
    setLoading(true);
    setFixMsg(null);
    try {
      const [leadsResp, activitiesResp] = await Promise.all([
        railwayLeads.list({ sort: "-created_date", limit: 3000 }),
        railwayActivities.list({ limit: 3000 }),
      ]);
      const [allLeads, activities] = [leadsResp.items || [], activitiesResp.items || []];

      // Only keep leads with a future or same-day Meeting appointment
      const today = new Date().toISOString().slice(0, 10);
      const relevant = allLeads.filter(l => {
        const date = l.appointment_date || l.follow_up_date;
        return l.follow_up_type === "Meeting" && date >= today;
      });
      relevant.sort((a, b) => {
        const da = a.appointment_date || a.follow_up_date;
        const db = b.appointment_date || b.follow_up_date;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      setLeads(relevant);

      // Build sent keys from activity log
      const keys = new Set(
        activities
          .filter(a => a.content?.startsWith("REMINDER_SENT:"))
          .map(a => a.content.replace("REMINDER_SENT:", "").trim())
      );
      setSentKeys(keys);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const fixLead = async (lead) => {
    setFixingId(lead.id);
    setFixMsg(null);
    try {
      const externalRef = lead.external_ref || lead.id;
      const res = await railwayLeads.syncCalendar(externalRef);
      if (res?.success) {
        setFixMsg({ type: "success", text: `✓ Calendar synced for ${lead.first_name} ${lead.last_name}` });
        await load();
      } else {
        setFixMsg({ type: "error", text: `Fix failed: ${res?.error || res?.message || "Unknown error"}` });
      }
    } catch (e) {
      setFixMsg({ type: "error", text: e.message });
    } finally {
      setFixingId(null);
    }
  };

  const fixAll = async () => {
    const broken = leads.filter(l => !l.google_event_id);
    setFixMsg({ type: "info", text: `Fixing ${broken.length} leads…` });
    for (const lead of broken) {
      await fixLead(lead);
    }
    setFixMsg({ type: "success", text: `Done — fixed ${broken.length} leads` });
  };

  // Compute issue stats
  const WINDOW_MINS = { "48h": 2880, "24h": 1440, "12h": 720, "2h": 120, "30min": 30 };
  const now = Date.now();

  function pacificToUtcMs(dateStr, timeStr) {
    try {
      const probe = new Date(`${dateStr}T12:00:00Z`);
      const laHour = Number(new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
      }).format(probe));
      const [y, mo, d] = dateStr.split("-").map(Number);
      const [h, m] = (timeStr || "09:00").split(":").map(Number);
      return Date.UTC(y, mo - 1, d, h - (laHour - 12), m, 0);
    } catch { return 0; }
  }

  const withIssues = leads.filter(l => {
    if (!l.google_event_id) return true;
    if (!l.google_travel_event_id) return true;
    if (l.google_calendar_sync_status === "error") return true;
    const apptDate = l.appointment_date || l.follow_up_date;
    const apptMs = pacificToUtcMs(apptDate, l.appointment_time || l.follow_up_time || "09:00");
    const missedAny = REMINDER_WINDOWS.some(win => {
      const targetMs = apptMs - WINDOW_MINS[win] * 60 * 1000;
      return targetMs <= now && !sentKeys.has(`reminder:${l.id}:${win}:${apptDate}`);
    });
    return missedAny;
  });

  const ok = leads.filter(l => !withIssues.includes(l));
  const filtered = filter === "issues" ? withIssues : filter === "ok" ? ok : leads;
  const brokenCalCount = leads.filter(l => !l.google_event_id).length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-amber-600" />
          <h2 className="text-sm font-bold text-slate-900">Meeting → Calendar → Reminder Pipeline</h2>
        </div>
        <div className="flex items-center gap-2">
          {brokenCalCount > 0 && (
            <button
              onClick={fixAll}
              disabled={!!fixingId}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              <Zap className="w-3 h-3" />
              Fix All ({brokenCalCount})
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-slate-800">{leads.length}</div>
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Total Meetings</div>
        </div>
        <div className={`border rounded-lg p-2 text-center ${withIssues.length > 0 ? "bg-red-50 border-red-200" : "bg-emerald-50 border-emerald-200"}`}>
          <div className={`text-xl font-bold ${withIssues.length > 0 ? "text-red-700" : "text-emerald-700"}`}>{withIssues.length}</div>
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Issues Found</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-emerald-700">{ok.length}</div>
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Fully Synced</div>
        </div>
      </div>

      {fixMsg && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs font-semibold border ${
          fixMsg.type === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
          fixMsg.type === "error" ? "bg-red-50 border-red-200 text-red-700" :
          "bg-blue-50 border-blue-200 text-blue-700"
        }`}>{fixMsg.text}</div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-3">
        {[
          { key: "issues", label: `Issues (${withIssues.length})` },
          { key: "ok", label: `OK (${ok.length})` },
          { key: "all", label: `All (${leads.length})` },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-xs font-semibold border-b-2 transition-colors ${
              filter === f.key ? "border-amber-600 text-amber-700" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-center py-8">
          <div className="w-6 h-6 border-3 border-slate-200 border-t-amber-600 rounded-full animate-spin mx-auto mb-2" />
          <p className="text-xs text-slate-400">Loading pipeline data…</p>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-8 text-slate-400">
          <Bell className="w-6 h-6 mx-auto mb-2 opacity-30" />
          <p className="text-xs">{filter === "issues" ? "No issues found — all meetings are fully synced." : "No meetings in this view."}</p>
        </div>
      )}

      <div className="max-h-[600px] overflow-y-auto pr-1 space-y-0">
        {filtered.map(lead => (
          <LeadRow
            key={lead.id}
            lead={lead}
            sentKeys={sentKeys}
            onFix={fixLead}
            fixing={fixingId === lead.id}
          />
        ))}
      </div>
    </div>
  );
}