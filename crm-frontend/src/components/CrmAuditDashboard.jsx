import { useState } from "react";
import ReminderHealthPanel from "@/components/ReminderHealthPanel";
import { railwayRequest } from "@/lib/railwayClient";
import {
  CheckCircle, AlertTriangle, XCircle, RefreshCw, ChevronDown, ChevronUp,
  Bell, Calendar, Users, Briefcase, Eye, ClipboardList, Type, Play
} from "lucide-react";

const STATUS_CONFIG = {
  pass:    { label: "Pass",    color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", dot: "bg-emerald-500", Icon: CheckCircle },
  warning: { label: "Warning", color: "text-amber-700",   bg: "bg-amber-50 border-amber-200",     dot: "bg-amber-500",   Icon: AlertTriangle },
  fail:    { label: "Fail",    color: "text-red-700",     bg: "bg-red-50 border-red-200",         dot: "bg-red-500",     Icon: XCircle },
};

const CHECK_META = [
  { key: "appointment_reminders", label: "Appointment Reminders", Icon: Bell },
  { key: "calendar_sync",         label: "Google Calendar Sync",  Icon: Calendar },
  { key: "deduplication",         label: "Deduplication / Re-submissions", Icon: Users },
  { key: "deals_sync",            label: "Deals / Sold Leads",    Icon: Briefcase },
  { key: "owner_visibility",      label: "Owner Visibility",      Icon: Eye },
];

function StatusBadge({ status, size = "sm" }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pass;
  const { Icon } = cfg;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-bold ${cfg.bg} ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function CollapsibleSection({ title, count, status, children }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className="text-xs font-semibold text-slate-700">{title} <span className="text-slate-400">({count})</span></span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      {open && <div className="p-3 space-y-2 max-h-64 overflow-y-auto">{children}</div>}
    </div>
  );
}

function IssueRow({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-slate-500 flex-shrink-0">{label}</span>
      <span className={`text-slate-800 font-medium text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function CheckCard({ meta, data }) {
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const { Icon } = meta;
  const cfg = STATUS_CONFIG[data.status] || STATUS_CONFIG.pass;

  return (
    <div className={`rounded-lg border p-4 ${cfg.bg}`}>
      <button
        className="w-full flex items-center gap-3 text-left"
        onClick={() => setOpen(!open)}
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${data.status === 'pass' ? 'bg-emerald-100' : data.status === 'warning' ? 'bg-amber-100' : 'bg-red-100'}`}>
          <Icon className={`w-4 h-4 ${cfg.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-slate-800">{meta.label}</span>
            <StatusBadge status={data.status} />
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {getCheckSummaryLine(meta.key, data)}
          </p>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />}
      </button>

      {open && (
        <div className="mt-4 space-y-2 border-t border-white/60 pt-3">
          <CheckDetail checkKey={meta.key} data={data} />
          {data.recommended_fix && (
            <div className="mt-3 bg-white/70 rounded-lg p-3 border border-amber-200">
              <p className="text-xs font-semibold text-amber-800">💡 Recommended Fix</p>
              <p className="text-xs text-amber-700 mt-1">{data.recommended_fix}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getCheckSummaryLine(key, data) {
  if (key === 'appointment_reminders') return `${data.total_upcoming_appointments} upcoming appts · ${data.reminders_ready} ready · ${data.reminders_with_issues} with issues`;
  if (key === 'calendar_sync') return `${data.total_upcoming_meetings} upcoming meetings · ${data.calendar_synced} synced · ${data.calendar_issues} issues`;
  if (key === 'deduplication') return `${data.active_leads_scanned} leads scanned · ${data.duplicate_groups_found} duplicate groups · ${data.resubmissions_missing_record} missing history`;
  if (key === 'deals_sync') return `${data.sold_leads} sold leads · ${data.deals_synced} have deals · ${data.sold_leads_missing_deal} missing`;
  if (key === 'owner_visibility') return `${data.total_users} users · ${data.sales_reps} reps · ${data.unassigned_active_leads} unassigned leads`;
  return '';
}

function CheckDetail({ checkKey, data }) {
  if (checkKey === 'appointment_reminders') {
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Upcoming (72h)', value: data.total_upcoming_appointments },
            { label: 'Ready', value: data.reminders_ready },
            { label: 'Issues', value: data.reminders_with_issues },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-lg font-black text-slate-800">{s.value}</div>
              <div className="text-[10px] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <CollapsibleSection title="Issues found" count={data.issues?.length} status={data.status}>
          {data.issues?.map((issue, i) => (
            <div key={i} className="bg-white rounded p-2.5 space-y-1 border border-slate-100">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">{issue.name}</span>
                <span className="text-[10px] text-slate-400">{issue.hours_until}h away</span>
              </div>
              <IssueRow label="Customer email" value={issue.has_customer_email ? '✅' : '❌ Missing'} />
              <IssueRow label="Rep email" value={issue.has_rep_email ? '✅' : '❌ Not configured'} />
              <IssueRow label="Delivery" value={issue.delivery_method} />
              <div className="flex flex-wrap gap-1 mt-1">
                {issue.issues.map(iss => (
                  <span key={iss} className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-mono">{iss}</span>
                ))}
              </div>
            </div>
          ))}
        </CollapsibleSection>
      </>
    );
  }

  if (checkKey === 'calendar_sync') {
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Meetings', value: data.total_upcoming_meetings },
            { label: 'Synced', value: data.calendar_synced },
            { label: 'Issues', value: data.calendar_issues },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-lg font-black text-slate-800">{s.value}</div>
              <div className="text-[10px] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        {data.note && <p className="text-[11px] text-slate-500 italic mt-2">{data.note}</p>}
        <CollapsibleSection title="Calendar issues" count={data.issues?.length}>
          {data.issues?.map((issue, i) => (
            <div key={i} className="bg-white rounded p-2.5 space-y-1 border border-slate-100">
              <span className="text-xs font-semibold text-slate-800">{issue.name}</span>
              <IssueRow label="Appointment" value={issue.appointment_date} />
              <IssueRow label="Sync status" value={issue.sync_status} />
              <IssueRow label="Event ID" value={issue.google_event_id || '—'} mono />
              <div className="flex flex-wrap gap-1">
                {issue.issues.map(iss => (
                  <span key={iss} className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-mono">{iss}</span>
                ))}
              </div>
            </div>
          ))}
        </CollapsibleSection>
      </>
    );
  }

  if (checkKey === 'deduplication') {
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Scanned', value: data.active_leads_scanned },
            { label: 'Dup Groups', value: data.duplicate_groups_found },
            { label: 'Missing History', value: data.resubmissions_missing_record },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-lg font-black text-slate-800">{s.value}</div>
              <div className="text-[10px] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <IssueRow label="Recent re-submissions" value={data.recent_resubmissions} />
        <IssueRow label="With history record" value={data.resubmissions_with_history_record} />
        <CollapsibleSection title="Duplicate groups" count={data.duplicates?.length}>
          {data.duplicates?.map((dup, i) => (
            <div key={i} className="bg-white rounded p-2.5 border border-slate-100 space-y-1">
              <span className="text-[10px] font-mono text-slate-400">{dup.match_key}</span>
              <div className="flex flex-wrap gap-1">
                {dup.names.map((n, j) => <span key={j} className="text-[10px] bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-semibold">{n}</span>)}
              </div>
            </div>
          ))}
        </CollapsibleSection>
      </>
    );
  }

  if (checkKey === 'deals_sync') {
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Sold Leads', value: data.sold_leads },
            { label: 'Have Deals', value: data.deals_synced },
            { label: 'Missing', value: data.sold_leads_missing_deal },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-lg font-black text-slate-800">{s.value}</div>
              <div className="text-[10px] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <CollapsibleSection title="Missing deals" count={data.missing_deals?.length}>
          {data.missing_deals?.map((item, i) => (
            <div key={i} className="bg-white rounded p-2.5 border border-slate-100">
              <span className="text-xs font-semibold text-slate-800">{item.name}</span>
              <p className="text-[10px] text-slate-400 font-mono mt-0.5">{item.lead_id}</p>
            </div>
          ))}
        </CollapsibleSection>
      </>
    );
  }

  if (checkKey === 'owner_visibility') {
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Total Users', value: data.total_users },
            { label: 'Sales Reps', value: data.sales_reps },
            { label: 'Unassigned', value: data.unassigned_active_leads },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-lg font-black text-slate-800">{s.value}</div>
              <div className="text-[10px] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="bg-white/70 rounded-lg p-2.5 border border-emerald-200 text-xs text-emerald-700 mt-2">
          ✅ Admins/Managers can see all leads · RLS enforces sales rep isolation
        </div>
        {data.issues?.map((issue, i) => (
          <div key={i} className="bg-white rounded p-2.5 border border-amber-100 mt-2">
            <p className="text-xs text-amber-800">{issue.message}</p>
          </div>
        ))}
      </>
    );
  }

  return null;
}

function NameNormalizationPanel() {
  const [dryRunResult, setDryRunResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState(null);
  const [fixOffset, setFixOffset] = useState(0);
  const [error, setError] = useState(null);

  const runDryRun = async () => {
    setRunning(true);
    setError(null);
    setDryRunResult(null);
    setFixResult(null);
    try {
      const res = await railwayRequest('/admin/normalize-names', { dry_run: true });
      setDryRunResult(res?.report || res);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const applyFix = async (offset = 0) => {
    setFixing(true);
    setError(null);
    try {
      const data = await railwayRequest('/admin/normalize-names', { dry_run: false, batch_size: 50, offset });
      setFixResult(prev => prev ? {
        ...data,
        corrected: (prev.corrected || 0) + (data.corrected || 0),
      } : data);
      setFixOffset(data.next_offset || 0);
      if (data.has_more) {
        // Auto-continue
        setTimeout(() => applyFix(data.next_offset), 1000);
      } else {
        setFixing(false);
      }
    } catch (e) {
      setError(e.message);
      setFixing(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center flex-shrink-0">
          <Type className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-bold text-slate-900">Name Normalization Audit</h2>
          <p className="text-xs text-slate-500 mt-1">
            Finds and fixes ALL CAPS, all lowercase, or mixed-case names (e.g. JOE ALBARRAN → Joe Albarran).
          </p>
        </div>
        <button
          onClick={runDryRun}
          disabled={running || fixing}
          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-3 py-2 text-xs font-bold rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">{error}</div>}

      {dryRunResult && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Total Leads', value: dryRunResult.total_scanned },
              { label: 'Need Fixing', value: dryRunResult.total_needing_fix },
              { label: 'Already Correct', value: dryRunResult.already_correct ?? ((dryRunResult.total_scanned || 0) - (dryRunResult.total_needing_fix || 0)) },
            ].map(s => (
              <div key={s.label} className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                <div className="text-xl font-black text-slate-800">{s.value ?? '—'}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
          {dryRunResult.by_field && Object.values(dryRunResult.by_field).some(v => v > 0) && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Issues by field</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(dryRunResult.by_field).filter(([, v]) => v > 0).map(([f, v]) => (
                  <span key={f} className="text-xs bg-white border border-slate-200 rounded px-2 py-1 font-mono">
                    {f}: <span className="font-bold text-amber-700">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {dryRunResult.sample && dryRunResult.sample.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1.5">Sample corrections (first 20)</p>
              <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                {dryRunResult.sample.map((item, i) => (
                  <div key={i} className="px-3 py-2 border-b border-slate-100 last:border-0 text-xs space-y-0.5">
                    {Object.entries(item.updates || item.changes).map(([field, val]) => {
                      const toVal = typeof val === 'object' ? val.to : val;
                      const fromVal = item.name || (typeof val === 'object' ? val.from : '');
                      return (
                        <div key={field} className="flex items-center gap-2">
                          <span className="text-slate-400 w-20 flex-shrink-0">{field}:</span>
                          <span className="text-red-600 font-mono">{fromVal}</span>
                          <span className="text-slate-400">→</span>
                          <span className="text-emerald-700 font-mono font-semibold">{toVal}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {dryRunResult.total_needing_fix > 0 && !fixResult && (
            <button
              onClick={() => applyFix(0)}
              disabled={fixing}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              <Play className={`w-3.5 h-3.5 ${fixing ? 'animate-spin' : ''}`} />
              {fixing ? `Fixing… (batch at offset ${fixOffset})` : `Apply Fixes to ${dryRunResult.total_needing_fix} Records`}
            </button>
          )}

          {fixResult && (
            <div className={`rounded-lg p-4 border ${fixResult.has_more ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
              <p className="text-xs font-bold text-slate-800">
                {fixResult.has_more ? `In progress…` : '✅ All done!'}
              </p>
              <p className="text-xs text-slate-600 mt-1">{fixResult.message || `Fixed ${fixResult.corrected} records.`}</p>
              {fixing && <RefreshCw className="w-4 h-4 text-slate-400 animate-spin mt-2" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CrmAuditDashboard() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const runAudit = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const res = await railwayRequest('/admin/crm-audit', {});
      setReport(res);
    } catch (e) {
      setError(e.message || 'Audit failed');
    } finally {
      setRunning(false);
    }
  };

  const overallCfg = report ? (STATUS_CONFIG[report.overall_status] || STATUS_CONFIG.pass) : null;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Reminder Health */}
      <ReminderHealthPanel />

      {/* Name Normalization */}
      <NameNormalizationPanel />

      {/* Run Button */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center flex-shrink-0">
            <ClipboardList className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-bold text-slate-900">CRM System Audit</h2>
            <p className="text-xs text-slate-500 mt-1">
              Checks appointment reminders, calendar sync, deduplication, deal alignment, and sales rep visibility in one pass.
            </p>
          </div>
          <button
            onClick={runAudit}
            disabled={running}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2.5 text-xs font-bold rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Running…' : 'Run CRM Audit'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>
      )}

      {report && (
        <>
          {/* Overall banner */}
          <div className={`rounded-xl border p-5 ${overallCfg.bg}`}>
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${overallCfg.dot}`} />
              <div>
                <span className="text-base font-black text-slate-800">Overall: </span>
                <StatusBadge status={report.overall_status} />
              </div>
              <div className="ml-auto text-right">
                <div className="text-xs text-slate-500">Run at</div>
                <div className="text-xs font-semibold text-slate-700">{new Date(report.run_at).toLocaleString()}</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-2">
              {CHECK_META.map(meta => {
                const summary = report.summary[meta.key];
                const cfg = STATUS_CONFIG[summary?.status] || STATUS_CONFIG.pass;
                return (
                  <div key={meta.key} className={`rounded-lg p-2 text-center border ${cfg.bg}`}>
                    <div className={`w-5 h-5 mx-auto mb-1 ${cfg.color}`}>
                      <meta.Icon className="w-5 h-5" />
                    </div>
                    <StatusBadge status={summary?.status} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-check cards */}
          <div className="space-y-3">
            {CHECK_META.map(meta => (
              <CheckCard key={meta.key} meta={meta} data={report.checks[meta.key]} />
            ))}
          </div>

          {/* Raw JSON toggle */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xs font-semibold text-slate-700">Raw JSON Report</span>
              {showRaw ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </button>
            {showRaw && (
              <pre className="p-4 text-[10px] font-mono text-slate-600 bg-slate-50 overflow-x-auto max-h-96 overflow-y-auto border-t border-slate-100">
                {JSON.stringify(report, null, 2)}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}