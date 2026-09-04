import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import * as railwayLeads from "@/api/railway/leads";
import { Link } from "react-router-dom";
import {
  Phone, Calendar, CheckCircle, Mail, ExternalLink, ArrowRight,
  Clock, AlertTriangle, TrendingUp, DollarSign, ChevronDown, ChevronUp, Users
} from "lucide-react";
import ContactActions from "@/components/ContactActions";
import { statusBadgeClass } from "@/lib/design-system";
import { formatPhone } from "@/lib/formatters";
import { isActiveSalesLead } from "@/lib/activeLeadFilter";
import { computeDealMetrics, formatDashboardCurrency } from "@/lib/dashboardMetrics";


// ── Helpers ────────────────────────────────────────────────────────────────

function fmt12(t) {
  if (!t) return '';
  const normalized = String(t).replace(/\s*(AM|PM)/i, '').trim();
  const [h, m] = normalized.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Parse a YYYY-MM-DD date string as a plain integer YYYYMMDD for local-date comparison.
// This avoids any UTC/timezone conversion — we compare calendar dates directly.
function parseDateInt(dateStr) {
  const m = String(dateStr || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]);
}

// Returns today's date as YYYYMMDD integer using local time (no UTC shift).
function todayInt() {
  const n = new Date();
  return n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
}

// Returns tomorrow's date as YYYYMMDD integer using local time.
function tomorrowInt() {
  const n = new Date();
  n.setDate(n.getDate() + 1);
  return n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
}

// Returns date N days from now as YYYYMMDD integer using local time.
function futureDateInt(daysAhead) {
  const n = new Date();
  n.setDate(n.getDate() + daysAhead);
  return n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
}

// Number of calendar days between two YYYYMMDD integers (approximate, good enough for bucketing).
function daysBetweenInts(fromInt, toInt) {
  // Convert back to Date for accurate diff
  const from = new Date(Math.floor(fromInt / 10000), Math.floor((fromInt % 10000) / 100) - 1, fromInt % 100);
  const to = new Date(Math.floor(toInt / 10000), Math.floor((toInt % 10000) / 100) - 1, toInt % 100);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

function daysAgoFromUTC(utcMs) {
  if (!utcMs) return null;
  const todayUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Math.floor((todayUTC - utcMs) / (1000 * 60 * 60 * 24));
}

// Format a date string as a human-readable label — always shows real date, not "Today"
function formatFollowUpDate(dateStr) {
  const d = parseDateInt(dateStr);
  if (!d) return dateStr;
  const today = todayInt();
  const tomorrow = tomorrowInt();
  if (d === today) return 'Today';
  if (d === tomorrow) return 'Tomorrow';
  const diff = daysBetweenInts(d, today); // positive = in the past
  if (diff === 1) return 'Yesterday';
  if (diff > 1) return `${diff}d overdue`;
  // future
  const daysAhead = daysBetweenInts(today, d);
  // Show real date for future dates
  const [yr, mo, dy] = [Math.floor(d / 10000), Math.floor((d % 10000) / 100) - 1, d % 100];
  return new Date(yr, mo, dy).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function parseBudgetValue(budgetStr) {
  if (!budgetStr) return 0;
  if (budgetStr.includes('300,000+')) return 300000;
  const nums = budgetStr.replace(/[^0-9]/g, ' ').trim().split(/\s+/).map(Number).filter(Boolean);
  if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  return nums[0] || 0;
}

// Note: EXCLUDED_STATUSES moved to activeLeadFilter.js and renamed INACTIVE_STATUSES
// to avoid drift between dashboard and leads page

// STATUS_COLORS replaced by statusBadgeClass() from design-system

const colorMap = {
  blue: 'bg-blue-50 border-blue-200 text-blue-700',
  indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  orange: 'bg-orange-50 border-orange-200 text-orange-700',
  red: 'bg-red-50 border-red-200 text-red-700',
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  slate: 'bg-slate-50 border-slate-200 text-slate-700',
};

const DATE_FILTER_OPTIONS = [
  { label: 'Last 7 Days', days: 7 },
  { label: 'Last 14 Days', days: 14 },
  { label: 'Last 30 Days', days: 30 },
  { label: 'All Time', days: null },
];

// ── Main Component ─────────────────────────────────────────────────────────

export default function FollowUpsWidget({ leads: propLeads, allLeads: propAllLeads, deals: propDeals, dateRangeMode }) {
  const [completing, setCompleting] = useState({});
  const [leads, setLeads] = useState(propLeads || []);
  const [allLeads, setAllLeads] = useState(propAllLeads || propLeads || []);
  const [deals, setDeals] = useState(propDeals || []);
  const [olderExpanded, setOlderExpanded] = useState(true);

  // Build deal lookup map by lead_id for revenue calculation
  const dealMap = useMemo(() => {
    const map = {};
    for (const d of (deals || [])) if (d.lead_id) map[d.lead_id] = d;
    return map;
  }, [deals]);

  useMemo(() => { if (propLeads) setLeads(propLeads); }, [propLeads]);
  useMemo(() => { setAllLeads(propAllLeads || propLeads || []); }, [propAllLeads, propLeads]);
  useMemo(() => { setDeals(propDeals || []); }, [propDeals]);

  // When a past date range is selected, show a flat list of all leads in that window
  const isPastRange = dateRangeMode?.direction === 'past';

  // ── Active leads within date window ──────────────────────────────────
  const activeLeads = useMemo(() => {
    return leads.filter(isActiveSalesLead);
  }, [leads]);

  // ── Today/Tomorrow/This week sections (from activeLeads only) ────────
  // Uses local-date integers (YYYYMMDD) to avoid UTC/timezone bucketing errors.
  const sections = useMemo(() => {
    const todayMeetings = [], todayCalls = [], tomorrowMeetings = [], tomorrowCalls = [], thisWeekMeetings = [], thisWeekCalls = [];
    const seen = new Set();
    const today = todayInt();
    const tomorrow = tomorrowInt();
    const in7days = futureDateInt(7);

    for (const l of activeLeads) {
      // follow_up_date is primary — bucket by its real local date
      if (l.follow_up_date) {
        const d = parseDateInt(l.follow_up_date);
        if (d === null) continue;
        const isMeeting = l.follow_up_type === 'Meeting';
        if (d === today) {
          (isMeeting ? todayMeetings : todayCalls).push({ lead: l, sectionDate: l.follow_up_date });
          seen.add(l.id);
        } else if (d === tomorrow) {
          (isMeeting ? tomorrowMeetings : tomorrowCalls).push({ lead: l, sectionDate: l.follow_up_date });
          seen.add(l.id);
        } else if (d > tomorrow && d <= in7days) {
          (isMeeting ? thisWeekMeetings : thisWeekCalls).push({ lead: l, sectionDate: l.follow_up_date });
          seen.add(l.id);
        }
      }

      // appointment_date also feeds sections if not already bucketed via follow_up_date
      if (l.appointment_date && !seen.has(l.id)) {
        const d = parseDateInt(l.appointment_date);
        if (d === null) continue;
        if (d === today) {
          todayMeetings.push({ lead: l, sectionDate: l.appointment_date });
          seen.add(l.id);
        } else if (d === tomorrow) {
          tomorrowMeetings.push({ lead: l, sectionDate: l.appointment_date });
          seen.add(l.id);
        } else if (d > tomorrow && d <= in7days) {
          thisWeekMeetings.push({ lead: l, sectionDate: l.appointment_date });
          seen.add(l.id);
        }
      }
    }

    const sortByTime = (a, b) => (a.lead.follow_up_time || a.lead.appointment_time || '').localeCompare(b.lead.follow_up_time || b.lead.appointment_time || '');
    return {
      todayMeetings: todayMeetings.sort(sortByTime),
      todayCalls: todayCalls.sort(sortByTime),
      tomorrowMeetings: tomorrowMeetings.sort(sortByTime),
      tomorrowCalls: tomorrowCalls.sort(sortByTime),
      thisWeekMeetings: thisWeekMeetings.sort(sortByTime),
      thisWeekCalls: thisWeekCalls.sort(sortByTime),
    };
  }, [activeLeads]);

  // ── Older overdue (from ALL leads, grouped by age) ───────────────────
  const olderOverdue = useMemo(() => {
    const g15_30 = [], g30_60 = [], g60plus = [];
    const today = todayInt();
    for (const l of leads) {
      if (!isActiveSalesLead(l)) continue;
      if (!l.follow_up_date) continue;
      const d = parseDateInt(l.follow_up_date);
      if (!d || d >= today) continue;
      const daysOld = daysBetweenInts(d, today);
      if (daysOld > 60) g60plus.push(l);
      else if (daysOld > 30) g30_60.push(l);
      else if (daysOld >= 15) g15_30.push(l);
    }
    return { g15_30, g30_60, g60plus };
  }, [leads]);

  // ── Summary stats (use allLeads so totals are always full-set) ───────
  // Uses shared dashboardMetrics module — same definitions as getReportsData backend.
  const stats = useMemo(() => {
    const base = allLeads.filter(isActiveSalesLead);
    const apptScheduled = base.filter(l => l.status === 'Appointment scheduled').length;
    const estimateSent = base.filter(l => l.status === 'Proposal Sent').length;

    // CANONICAL deal metrics — same function as Deals page (computeDealMetrics).
    // This ensures Dashboard and Deals show the SAME soldThisMonth and
    // revenueThisMonth numbers. No per-component patch calculations.
    const dealMetrics = computeDealMetrics(deals);

    return {
      apptScheduled,
      estimateSent,
      soldThisMonth: dealMetrics.soldThisMonth,
      revenueThisMonth: dealMetrics.revenueThisMonth,
    };
  }, [allLeads, deals]);

  // ── Flat list for past date ranges (Last 7/14/21 days) ───────────────
  const pastRangeLeads = useMemo(() => {
    if (!isPastRange) return [];
    return leads
      .filter(isActiveSalesLead)
      .sort((a, b) => {
        const da = parseDateInt(a.follow_up_date || a.appointment_date) || 0;
        const db = parseDateInt(b.follow_up_date || b.appointment_date) || 0;
        return db - da; // most recent first
      });
  }, [leads, isPastRange]);

  const totalOlderOverdue = olderOverdue.g15_30.length + olderOverdue.g30_60.length + olderOverdue.g60plus.length;
  const totalToday = sections.todayMeetings.length + sections.todayCalls.length;
  const totalTomorrow = sections.tomorrowMeetings.length + sections.tomorrowCalls.length;
  const totalThisWeek = sections.thisWeekMeetings.length + sections.thisWeekCalls.length;
  const hasAnything = isPastRange
    ? pastRangeLeads.length > 0
    : totalToday > 0 || totalTomorrow > 0 || totalThisWeek > 0 || totalOlderOverdue > 0;

  // Helper to convert { lead, sectionDate }[] → plain lead arrays for legacy Group/LeadCard
  // We pass sectionDate as a prop override so cards display the correct date
  const unwrap = (entries) => entries.map(e => ({ ...e.lead, _sectionDate: e.sectionDate }));

  const handleComplete = async (e, lead) => {
    e.preventDefault();
    e.stopPropagation();
    setCompleting(prev => ({ ...prev, [lead.id]: true }));
    try {
      // Use updateAppointment (PUT /:id/appointment) — NOT the generic update
      // (PUT /:id). Only the appointment route cancels the appointment row and
      // enqueues the calendar outbox cancellation so the Google Calendar event
      // is removed. The generic update route only changes lead fields with no
      // calendar side effects, which would orphan the calendar event.
      const res = await railwayLeads.updateAppointment(lead.id, {
        follow_up_date: null, follow_up_time: null, follow_up_type: null,
      });
      const updated = res?.lead || {
        ...lead, follow_up_date: null, follow_up_time: null, follow_up_type: null,
      };
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    } catch (err) {
      console.error('[FollowUpsWidget] Failed to clear follow-up:', err?.message);
    } finally {
      setCompleting(prev => ({ ...prev, [lead.id]: false }));
    }
  };

  if (!hasAnything && activeLeads.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Active lead count */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">{activeLeads.length} active leads in view</span>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* ── Left: Main follow-up sections ── */}
        <div className="flex-1 min-w-0 space-y-3 w-full">

          {/* ── PAST RANGE MODE: flat list ── */}
          {isPastRange ? (
            <>
              {pastRangeLeads.length > 0 ? (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-500" />
                    <h2 className="text-sm font-bold text-slate-800">{dateRangeMode.label} – Follow-ups &amp; Appointments</h2>
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ml-1">{pastRangeLeads.length}</span>
                  </div>
                  <Group label="" leads={pastRangeLeads} onComplete={handleComplete} completing={completing} noLabel />
                </div>
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 py-8 text-center text-sm text-slate-400">
                  No follow-ups found for {dateRangeMode.label.toLowerCase()} 🎉
                </div>
              )}
            </>
          ) : (
            <>
              {/* ── FORWARD MODE: Today / Tomorrow / This Week / Older Overdue ── */}

              {/* Today's Work */}
              {(sections.todayMeetings.length > 0 || sections.todayCalls.length > 0) && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-500" />
                    <h2 className="text-sm font-bold text-slate-800">Today's Work</h2>
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 ml-1">{totalToday}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {sections.todayMeetings.length > 0 && (
                      <Group label="📅 Today's Meetings" labelClass="text-purple-700 bg-purple-50" leads={unwrap(sections.todayMeetings)} onComplete={handleComplete} completing={completing} />
                    )}
                    {sections.todayCalls.length > 0 && (
                      <Group label="📞 Today's Calls" labelClass="text-green-700 bg-green-50" leads={unwrap(sections.todayCalls)} onComplete={handleComplete} completing={completing} />
                    )}
                  </div>
                </div>
              )}

              {/* Tomorrow's Meetings + Calls */}
              {totalTomorrow > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-indigo-500" />
                    <h2 className="text-sm font-bold text-slate-800">Tomorrow</h2>
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 ml-1">{totalTomorrow}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {sections.tomorrowMeetings.length > 0 && (
                      <Group label="📅 Tomorrow's Meetings" labelClass="text-purple-700 bg-purple-50" leads={unwrap(sections.tomorrowMeetings)} onComplete={handleComplete} completing={completing} />
                    )}
                    {sections.tomorrowCalls.length > 0 && (
                      <Group label="📞 Tomorrow's Calls" labelClass="text-green-700 bg-green-50" leads={unwrap(sections.tomorrowCalls)} onComplete={handleComplete} completing={completing} />
                    )}
                  </div>
                </div>
              )}

              {/* This Week – Meetings + Calls */}
              {totalThisWeek > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <h2 className="text-sm font-bold text-slate-800">Next 7 Days</h2>
                    <span className="text-[11px] font-semibold text-slate-400 ml-1">{totalThisWeek}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {sections.thisWeekMeetings.length > 0 && (
                      <Group label="📅 Upcoming Meetings" labelClass="text-purple-700 bg-purple-50" leads={unwrap(sections.thisWeekMeetings)} onComplete={handleComplete} completing={completing} />
                    )}
                    {sections.thisWeekCalls.length > 0 && (
                      <Group label="📞 Upcoming Calls" labelClass="text-green-700 bg-green-50" leads={unwrap(sections.thisWeekCalls)} onComplete={handleComplete} completing={completing} />
                    )}
                  </div>
                </div>
              )}

              {/* Older Overdue – collapsible */}
              {totalOlderOverdue > 0 && (
                <div className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden">
                  <button
                    onClick={() => setOlderExpanded(v => !v)}
                    className="w-full px-5 py-3 border-b border-red-100 flex items-center justify-between hover:bg-red-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                      <h2 className="text-sm font-bold text-red-700">Older Follow-Ups (Overdue)</h2>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">{totalOlderOverdue}</span>
                    </div>
                    {olderExpanded ? <ChevronUp className="w-4 h-4 text-red-400" /> : <ChevronDown className="w-4 h-4 text-red-400" />}
                  </button>
                  {olderExpanded && (
                    <div className="divide-y divide-slate-100">
                      {olderOverdue.g15_30.length > 0 && (
                        <Group label={`15–30 days overdue (${olderOverdue.g15_30.length})`} labelClass="text-orange-700 bg-orange-50" leads={olderOverdue.g15_30} onComplete={handleComplete} completing={completing} isOverdue />
                      )}
                      {olderOverdue.g30_60.length > 0 && (
                        <Group label={`30–60 days overdue (${olderOverdue.g30_60.length})`} labelClass="text-red-700 bg-red-50" leads={olderOverdue.g30_60} onComplete={handleComplete} completing={completing} isOverdue />
                      )}
                      {olderOverdue.g60plus.length > 0 && (
                        <Group label={`60+ days overdue (${olderOverdue.g60plus.length})`} labelClass="text-red-900 bg-red-100" leads={olderOverdue.g60plus} onComplete={handleComplete} completing={completing} isOverdue />
                      )}
                    </div>
                  )}
                </div>
              )}

              {totalToday === 0 && totalTomorrow === 0 && totalThisWeek === 0 && totalOlderOverdue === 0 && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 py-8 text-center text-sm text-slate-400">
                  No follow-ups scheduled for today or this week 🎉
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right: Summary Panel ── */}
        <div className="w-full lg:w-52 lg:flex-shrink-0 grid grid-cols-2 lg:grid-cols-1 gap-2 lg:gap-2.5 lg:space-y-0">
          <SummaryCard icon={<Users className="w-4 h-4 text-blue-500" />} label="Active Leads" value={allLeads.filter(isActiveSalesLead).length} color="blue" />
          <SummaryCard icon={<Calendar className="w-4 h-4 text-indigo-500" />} label="Appointments Scheduled" value={stats.apptScheduled} color="indigo" />
          <SummaryCard icon={<TrendingUp className="w-4 h-4 text-purple-500" />} label="Estimates Sent" value={stats.estimateSent} color="slate" />
          <SummaryCard icon={<CheckCircle className="w-4 h-4 text-emerald-500" />} label="Sold This Month" value={stats.soldThisMonth} color="emerald" />
          <SummaryCard
            icon={<DollarSign className="w-4 h-4 text-emerald-600" />}
            label="Revenue This Month"
            value={formatDashboardCurrency(stats.revenueThisMonth)}
            color="emerald"
          />
          {totalOlderOverdue > 0 && (
            <button onClick={() => setOlderExpanded(true)} className="w-full">
              <SummaryCard icon={<AlertTriangle className="w-4 h-4 text-red-500" />} label="Older Overdue (click to view)" value={totalOlderOverdue} color="red" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Group Section ──────────────────────────────────────────────────────────

function Group({ label, labelClass, leads, onComplete, completing, isOverdue, noLabel }) {
  return (
    <div>
      {!noLabel && label && (
        <div className={`px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider ${labelClass}`}>
          {label}
        </div>
      )}
      <div className="divide-y divide-slate-50">
        {leads.map(lead => (
          <LeadCard key={lead.id} lead={lead} onComplete={onComplete} completing={completing} isOverdue={isOverdue} />
        ))}
      </div>
    </div>
  );
}

// ── Compact Lead Card ──────────────────────────────────────────────────────

function LeadCard({ lead, onComplete, completing, isOverdue }) {
  const navigate = useNavigate();
  const isMeeting = lead.follow_up_type === 'Meeting';
  const isPhone = lead.follow_up_type === 'Phone Call';

  const accentColor = isOverdue ? 'border-l-red-400' : isMeeting ? 'border-l-purple-400' : 'border-l-green-400';
  const typeColor = isMeeting ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700';
  const typeIcon = isMeeting ? '📅' : '📞';

  const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  const createdDateStr = (lead.crm_created_date || lead.created_date || '').slice(0, 10);
  const createdDays = daysAgoFromUTC(Date.UTC(
    ...createdDateStr.split('-').map((v, i) => i === 1 ? parseInt(v) - 1 : parseInt(v))
  ));
  // Display the real follow_up_date; if bucketed via appointment_date, show that
  const displayDate = lead.follow_up_date || lead._sectionDate;
  const followUpLabel = formatFollowUpDate(displayDate);
  const timeLabel = lead.follow_up_time ? fmt12(lead.follow_up_time) : (lead._sectionDate === lead.appointment_date && lead.appointment_time ? fmt12(lead.appointment_time) : '');

  const handleRowClick = () => {
    navigate(`/leads/${lead.id}`);
  };

  return (
    <div 
      onClick={handleRowClick}
      className={`border-l-4 ${accentColor} pl-3 pr-3 py-2.5 mx-3 my-1.5 bg-slate-50 rounded-r-lg hover:bg-white transition-colors cursor-pointer group`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-bold text-slate-900 group-hover:text-amber-600 transition-colors">{clientName}</span>
            {lead.follow_up_type && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${typeColor}`}>
                {typeIcon} {lead.follow_up_type}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            {lead.project_type && (
              <span className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded font-medium">{lead.project_type}</span>
            )}
            {lead.city && (
              <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">📍 {lead.city}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <div onClick={e => e.stopPropagation()}>
            <ContactActions phone={lead.phone} email={lead.email} size="sm" />
          </div>
          <button onClick={(e) => onComplete(e, lead)} disabled={completing[lead.id]}
            className="p-1.5 rounded-md bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors disabled:opacity-40" title="Mark Complete">
            <CheckCircle className="w-3 h-3" />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-0.5" />
          <button onClick={handleRowClick}
            className="p-1.5 rounded-md bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" title="Open Lead Details">
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Info row — horizontal, fills full width */}
      <div className="flex items-center gap-3 flex-wrap text-[11px]">
        {lead.phone && (
          <span className="flex items-center gap-1 text-slate-600">
            <span className="text-slate-400">📞</span>
            <span>{formatPhone(lead.phone)}</span>
          </span>
        )}
        {lead.assigned_rep && (
          <span className="flex items-center gap-1 text-slate-600">
            <span className="text-slate-400">👤</span>
            <span>{lead.assigned_rep}</span>
          </span>
        )}
        {lead.status && (
          <span className={statusBadgeClass(lead.status)}>
            {lead.status}
          </span>
        )}
        {(followUpLabel || timeLabel) && (
          <span className={`flex items-center gap-1 font-semibold ${isOverdue ? 'text-red-600' : 'text-slate-700'}`}>
            <span className="text-slate-400">🗓</span>
            <span>{followUpLabel}{timeLabel ? ` · ${timeLabel}` : ''}</span>
          </span>
        )}
        {lead.appointment_date && !lead._sectionDate && (
          <span className="flex items-center gap-1 text-slate-500">
            <span className="text-slate-400">📆</span>
            <span>Appt: {lead.appointment_date}{lead.appointment_time ? ` ${fmt12(lead.appointment_time)}` : ''}</span>
          </span>
        )}
        {lead.budget_range && (
          <span className="flex items-center gap-1 text-slate-500">
            <span className="text-slate-400">💰</span>
            <span>{lead.budget_range}</span>
          </span>
        )}
        {createdDays !== null && (
          <span className="flex items-center gap-1 text-slate-400">
            <span>⏱</span>
            <span>{createdDays === 0 ? 'Created today' : `${createdDays}d old`}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Summary Card ───────────────────────────────────────────────────────────

function SummaryCard({ icon, label, value, color }) {
  const cls = colorMap[color] || colorMap.slate;
  return (
    <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${cls}`}>
      <div className="flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-lg font-black leading-tight">{value}</div>
        <div className="text-[11px] font-medium opacity-80 leading-tight">{label}</div>
      </div>
    </div>
  );
}