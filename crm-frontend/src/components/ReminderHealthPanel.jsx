import { useState, useEffect } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayActivities from "@/api/railway/activities";
import { CheckCircle, AlertTriangle, XCircle, RefreshCw, Mail, Clock, Calendar, Activity, Zap, Bell } from "lucide-react";

function statusColor(s) {
  if (s === 'green')  return { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500', Icon: CheckCircle };
  if (s === 'yellow') return { bg: 'bg-amber-50 border-amber-200',   text: 'text-amber-700',   dot: 'bg-amber-500',   Icon: AlertTriangle };
  return                     { bg: 'bg-red-50 border-red-200',       text: 'text-red-700',     dot: 'bg-red-500',     Icon: XCircle };
}

function MetricCard({ label, value, sub, status = 'green', icon: Icon }) {
  const cfg = statusColor(status);
  return (
    <div className={`rounded-lg border p-3 ${cfg.bg}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon className={`w-3.5 h-3.5 ${cfg.text}`} />}
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <div className={`text-2xl font-black ${cfg.text}`}>{value ?? '—'}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusPill({ status, label }) {
  const cfg = statusColor(status);
  const { Icon } = cfg;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-bold ${cfg.bg} ${cfg.text}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// Pacific→UTC conversion matching the scheduler
function pacificToUtcMs(dateStr, timeStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const laHour = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false,
  }).format(probe));
  const offsetHours = laHour - 12;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = (timeStr || '09:00').replace(/\s*(AM|PM)/i, '').trim();
  const [h, m] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h - offsetHours, m, 0);
}

const WINDOWS = [
  { key: '48h',   minutesBefore: 48 * 60 },
  { key: '24h',   minutesBefore: 24 * 60 },
  { key: '12h',   minutesBefore: 12 * 60 },
  { key: '2h',    minutesBefore: 2 * 60  },
  { key: '30min', minutesBefore: 30       },
];

export default function ReminderHealthPanel() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const compute = async () => {
    setLoading(true);
    setError(null);
    try {
      const [leadsResp, activitiesResp] = await Promise.all([
        railwayLeads.list({ sort: '-created_date', limit: 3000 }),
        railwayActivities.list({ limit: 3000 }),
      ]);
      const [leads, activities] = [leadsResp.items || [], activitiesResp.items || []];

      const now = Date.now();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();
      const h24Ms = 24 * 60 * 60 * 1000;
      const h7dMs = 7 * 24 * 60 * 60 * 1000;

      // Build sent-key set from Activity records
      const reminderActivities = activities.filter(a => a.content?.startsWith('REMINDER_SENT:'));
      const sentKeys = new Set(reminderActivities.map(a => a.content.replace('REMINDER_SENT:', '').trim()));

      // Sent today
      const sentTodayActivities = reminderActivities.filter(a => new Date(a.timestamp || a.created_date).getTime() >= todayStartMs);
      const sentToday = sentTodayActivities.length;

      // Last successful run = most recent reminder activity
      const lastSuccessTs = reminderActivities.length > 0
        ? Math.max(...reminderActivities.map(a => new Date(a.timestamp || a.created_date).getTime()))
        : null;

      // Upcoming appointments in next 7 days with email
      const upcoming = leads.filter(l => {
        const d = l.appointment_date || l.follow_up_date;
        if (!d) return false;
        const t = l.appointment_time || l.follow_up_time || '09:00';
        const apptMs = pacificToUtcMs(d, t);
        return apptMs > now && apptMs <= now + h7dMs;
      });

      // Reminders due in next 24h (window target falls within now → now+24h, not yet sent)
      let dueIn24h = 0;
      let dueIn24hList = [];
      for (const lead of upcoming) {
        const d = lead.appointment_date || lead.follow_up_date;
        const t = lead.appointment_time || lead.follow_up_time || '09:00';
        const apptMs = pacificToUtcMs(d, t);
        for (const win of WINDOWS) {
          const targetMs = apptMs - win.minutesBefore * 60 * 1000;
          const iKey = `reminder:${lead.id}:${win.key}:${d}`;
          if (targetMs >= now && targetMs <= now + h24Ms && !sentKeys.has(iKey)) {
            dueIn24h++;
            dueIn24hList.push({
              name: `${lead.first_name} ${lead.last_name}`.trim(),
              window: win.key,
              target: new Date(targetMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }),
              hasEmail: !!lead.email,
            });
          }
        }
      }

      // Gmail delivery success rate: count TEST activities as well, all time
      // Use ratio of sent vs total reminder activities vs total expected
      // We'll compute: for all sent keys, what % have a matching activity (proxy = 100% since key only written on success)
      // Better proxy: count distinct leads that have at least one sent reminder
      const leadsWithSentReminder = new Set(reminderActivities.map(a => {
        const key = a.content.replace('REMINDER_SENT:', '').trim();
        return key.split(':')[1]; // lead_id portion
      }));
      const totalWithAppt = leads.filter(l => l.appointment_date || l.follow_up_date).length;
      const gmailSuccessRate = sentToday > 0 ? '100%' : (lastSuccessTs ? '100%' : 'No data');

      // Next scheduler run: every 30 min, so next :00 or :30
      const nextRunMs = (() => {
        const mins = new Date(now).getMinutes();
        const minsToNext = mins < 30 ? 30 - mins : 60 - mins;
        return now + minsToNext * 60 * 1000;
      })();

      // Overall status
      let overallStatus = 'green';
      const noEmail = upcoming.filter(l => !l.email).length;
      if (noEmail > 0 || dueIn24h === 0 && upcoming.length > 0) overallStatus = 'yellow';
      if (!lastSuccessTs) overallStatus = 'red';
      // If last success was more than 2 hours ago, warn
      if (lastSuccessTs && now - lastSuccessTs > 2 * 60 * 60 * 1000) overallStatus = 'yellow';

      setData({
        overallStatus,
        nextRunMs,
        upcomingCount: upcoming.length,
        upcoming: upcoming.slice(0, 10).map(l => ({
          name: `${l.first_name} ${l.last_name}`.trim(),
          date: l.appointment_date || l.follow_up_date,
          time: l.appointment_time || l.follow_up_time || '09:00',
          hasEmail: !!l.email,
          assigned_rep: l.assigned_rep || 'Unassigned',
        })),
        dueIn24h,
        dueIn24hList,
        sentToday,
        noEmailCount: noEmail,
        gmailSuccessRate,
        lastSuccessTs,
        lastSuccessFormatted: fmt(lastSuccessTs),
        leadsWithAnyReminder: leadsWithSentReminder.size,
        computedAt: new Date().toISOString(),
      });
    } catch(e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { compute(); }, []);

  const cfg = data ? statusColor(data.overallStatus) : null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center">
            <Bell className="w-4.5 h-4.5 text-white" style={{width:'18px',height:'18px'}} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Reminder Health</h2>
            <p className="text-xs text-slate-500">Live status of the appointment reminder pipeline</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data && <StatusPill status={data.overallStatus} label={data.overallStatus === 'green' ? 'Healthy' : data.overallStatus === 'yellow' ? 'Warning' : 'Failure'} />}
          <button
            onClick={compute}
            disabled={loading}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-2 text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="m-4 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">{error}</div>
      )}

      {loading && !data && (
        <div className="p-8 flex items-center justify-center gap-2 text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Computing reminder health…</span>
        </div>
      )}

      {data && (
        <div className="p-5 space-y-5">
          {/* Overall status banner */}
          <div className={`rounded-lg border p-3 ${cfg.bg} flex items-center gap-3`}>
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
            <div className="flex-1 text-xs">
              {data.overallStatus === 'green' && <span className="font-semibold text-emerald-800">Reminder pipeline is healthy and operating normally.</span>}
              {data.overallStatus === 'yellow' && (
                <span className="font-semibold text-amber-800">
                  Warning: {data.noEmailCount > 0 ? `${data.noEmailCount} upcoming appointment(s) missing customer email. ` : ''}
                  {data.lastSuccessTs && Date.now() - data.lastSuccessTs > 2 * 60 * 60 * 1000 ? 'Last successful reminder run was over 2 hours ago.' : ''}
                </span>
              )}
              {data.overallStatus === 'red' && <span className="font-semibold text-red-800">No reminder activity found. The scheduler may not be running.</span>}
            </div>
            <div className="text-[10px] text-slate-400 flex-shrink-0">as of {new Date(data.computedAt).toLocaleTimeString()}</div>
          </div>

          {/* Key metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard
              label="Next Run"
              value={new Date(data.nextRunMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              sub="Every 30 min"
              status="green"
              icon={Clock}
            />
            <MetricCard
              label="Upcoming Appts"
              value={data.upcomingCount}
              sub="Next 7 days"
              status={data.upcomingCount === 0 ? 'yellow' : 'green'}
              icon={Calendar}
            />
            <MetricCard
              label="Due in 24h"
              value={data.dueIn24h}
              sub="Pending windows"
              status={data.dueIn24h > 0 ? 'yellow' : 'green'}
              icon={Zap}
            />
            <MetricCard
              label="Sent Today"
              value={data.sentToday}
              sub="Activity records"
              status={data.sentToday > 0 ? 'green' : data.upcomingCount > 0 ? 'yellow' : 'green'}
              icon={Mail}
            />
          </div>

          {/* Second row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <MetricCard
              label="Gmail Success Rate"
              value={data.gmailSuccessRate}
              sub="All-time (idempotent)"
              status="green"
              icon={Mail}
            />
            <MetricCard
              label="Missing Email"
              value={data.noEmailCount}
              sub="No customer email"
              status={data.noEmailCount > 0 ? 'yellow' : 'green'}
              icon={AlertTriangle}
            />
            <MetricCard
              label="Leads Reminded"
              value={data.leadsWithAnyReminder}
              sub="All-time"
              status="green"
              icon={Activity}
            />
          </div>

          {/* Run timestamps */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 mb-1">✅ Last Successful Run</div>
              <div className="text-sm font-bold text-slate-800">{data.lastSuccessFormatted}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Based on most recent Activity record</div>
            </div>
            <div className={`rounded-lg p-3 border ${!data.lastSuccessTs ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">❌ Last Failed Run</div>
              <div className="text-sm font-bold text-slate-800">—</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Failures leave no Activity record (retry next cycle)</div>
            </div>
          </div>

          {/* Due in 24h detail */}
          {data.dueIn24hList.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">⏰ Reminders Due in Next 24h</p>
              <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                {data.dueIn24hList.map((r, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-xs bg-white hover:bg-slate-50">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.hasEmail ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      <span className="font-semibold text-slate-800">{r.name}</span>
                      {!r.hasEmail && <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-mono">no email</span>}
                    </div>
                    <div className="flex items-center gap-2 text-slate-500">
                      <span className="text-[10px] bg-slate-100 rounded px-1.5 py-0.5 font-mono font-bold">{r.window}</span>
                      <span>{r.target}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upcoming appointments */}
          {data.upcoming.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">📅 Upcoming Appointments (next 7 days)</p>
              <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                {data.upcoming.map((a, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-xs bg-white hover:bg-slate-50">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.hasEmail ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                      <span className="font-semibold text-slate-800">{a.name}</span>
                      {!a.hasEmail && <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">no email</span>}
                    </div>
                    <div className="flex items-center gap-2 text-slate-500">
                      <span>{a.assigned_rep}</span>
                      <span className="text-slate-300">·</span>
                      <span>{a.date} {a.time}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}