import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { ChevronDown, ChevronUp, AlertCircle, CheckCircle, Clock, TrendingUp } from "lucide-react";

export default function HubSpotSyncResults({ syncState, totals }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    contacts: true,
    activities: true,
    leadTable: true,
    summary: true
  });

  useEffect(() => {
    if (totals && syncState.jobId) {
      loadLatestReport();
    }
  }, [totals, syncState?.jobId]);

  const loadLatestReport = async () => {
    setLoading(true);
    try {
      const jobId = syncState?.jobId;
      if (!jobId) {
        console.warn('No jobId available');
        setLoading(false);
        return;
      }
      const data = await apiCall('/api/v1/sync-reports?sync_job_id=' + jobId, { method: 'GET' });
      const reports = data.items || data || [];
      if (reports.length > 0) {
        setReport(reports[0]);
      } else {
        console.warn('No sync report found for jobId:', jobId);
      }
    } catch (err) {
      console.error('Failed to load report:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  if (loading) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded p-6 text-center">
        <p className="text-sm text-slate-500">Loading sync report...</p>
      </div>
    );
  }

  if (!report) {
    return null;
  }

  const { summary = {}, activities_breakdown = {}, lead_details = [], activity_details = [], error_log = [] } = report;

  return (
    <div className="space-y-4">
      {/* Final Summary */}
      <div className="bg-emerald-50 border border-emerald-200 rounded p-6">
        <h3 className="text-lg font-bold text-emerald-900 mb-4 flex items-center gap-2">
          <CheckCircle className="w-5 h-5" />
          Sync Report Summary
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Leads Processed" value={summary.total_contacts_found || 0} color="blue" />
          <StatCard label="Fully Synced" value={summary.leads_fully_synced || 0} color="emerald" />
          <StatCard label="Partially Synced" value={summary.leads_partially_synced || 0} color="amber" />
          <StatCard label="Failed" value={summary.leads_failed || 0} color="red" />
          <StatCard label="Created" value={summary.leads_created || 0} color="blue" />
          <StatCard label="Updated" value={summary.leads_updated || 0} color="purple" />
          <StatCard label="Merged" value={summary.leads_merged || 0} color="indigo" />
          <StatCard label="Skipped" value={summary.leads_skipped || 0} color="slate" />
        </div>
      </div>

      {/* Activities Breakdown */}
      <CollapsibleSection
        title="Activities by Type"
        icon="📊"
        isOpen={expandedSections.activities}
        onClick={() => toggleSection('activities')}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ActivityStat label="📝 Notes" count={activities_breakdown.notes || 0} />
          <ActivityStat label="☎️ Calls" count={activities_breakdown.calls || 0} />
          <ActivityStat label="📧 Emails" count={activities_breakdown.emails || 0} />
          <ActivityStat label="📅 Meetings" count={activities_breakdown.meetings || 0} />
          <ActivityStat label="✓ Tasks" count={activities_breakdown.tasks || 0} />
          <ActivityStat label="🤝 Deals" count={activities_breakdown.deals || 0} />
          <ActivityStat label="💼 Quotes" count={activities_breakdown.quotes || 0} />
          <ActivityStat label="📎 Attachments" count={activities_breakdown.attachments || 0} />
        </div>
        <div className="mt-3 pt-3 border-t border-slate-200 text-sm font-bold text-slate-800">
          Total Activities: <span className="text-emerald-700">{
            (activities_breakdown.notes || 0) + (activities_breakdown.calls || 0) + 
            (activities_breakdown.emails || 0) + (activities_breakdown.meetings || 0) + 
            (activities_breakdown.tasks || 0) + (activities_breakdown.deals || 0) + 
            (activities_breakdown.quotes || 0) + (activities_breakdown.attachments || 0)
          }</span>
        </div>
      </CollapsibleSection>

      {/* Per-Lead Table */}
      {lead_details.length > 0 && (
        <CollapsibleSection
          title="Per-Lead Sync Status"
          icon="👥"
          isOpen={expandedSections.leadTable}
          onClick={() => toggleSection('leadTable')}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-slate-700">Name</th>
                  <th className="px-3 py-2 text-left font-semibold text-slate-700">Email</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Contact</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Deals</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Notes</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Calls</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Emails</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Meetings</th>
                  <th className="px-3 py-2 text-center font-semibold text-slate-700">Tasks</th>
                  <th className="px-3 py-2 text-left font-semibold text-slate-700">Status</th>
                  <th className="px-3 py-2 text-left font-semibold text-slate-700">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lead_details.map((lead, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-800 font-medium">{lead.name || '—'}</td>
                    <td className="px-3 py-2 text-slate-600 truncate">{lead.email || '—'}</td>
                    <td className="px-3 py-2 text-center">{lead.contact_synced ? '✅' : '❌'}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.deals_count || 0}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.notes_count || 0}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.calls_count || 0}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.emails_count || 0}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.meetings_count || 0}</td>
                    <td className="px-3 py-2 text-center text-slate-700">{lead.tasks_count || 0}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={lead.status} />
                    </td>
                    <td className="px-3 py-2 text-red-600 text-xs truncate max-w-xs" title={lead.error_message}>
                      {lead.error_message ? '⚠️ Error' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      )}

      {/* Activity Details */}
      {activity_details.length > 0 && (
        <ActivityDetailsPanel details={activity_details} />
      )}

      {/* Error Log */}
      {error_log.length > 0 && (
        <CollapsibleSection
          title={`Error Log (${error_log.length} errors)`}
          icon="⚠️"
          isOpen={false}
          onClick={() => toggleSection('errors')}
        >
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {error_log.map((err, idx) => (
              <div key={idx} className="bg-red-50 border border-red-200 rounded p-3 text-xs">
                <div className="flex justify-between mb-1">
                  <span className="font-semibold text-red-900">{err.stage}</span>
                  <span className="text-red-600">{err.activity_type}</span>
                </div>
                <div className="text-red-700 mb-1">{err.error_message}</div>
                <div className="text-red-500 font-mono text-[10px]">
                  ID: {err.hubspot_id} | {err.endpoint}
                </div>
                <div className="text-red-400 text-[10px] mt-1">
                  {new Date(err.timestamp).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  const colors = {
    blue: "bg-blue-100 text-blue-800",
    emerald: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    purple: "bg-purple-100 text-purple-800",
    indigo: "bg-indigo-100 text-indigo-800",
    slate: "bg-slate-100 text-slate-800"
  };
  return (
    <div className={`rounded p-3 text-center ${colors[color]}`}>
      <div className="text-2xl font-black">{value}</div>
      <div className="text-xs font-semibold mt-0.5">{label}</div>
    </div>
  );
}

function ActivityStat({ label, count }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-3 text-center">
      <div className="text-2xl font-black text-slate-800">{count}</div>
      <div className="text-xs font-medium text-slate-600 mt-1">{label}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  const statusMap = {
    fully_synced: { bg: "bg-emerald-100", text: "text-emerald-700", label: "✅ Fully Synced" },
    partially_synced: { bg: "bg-amber-100", text: "text-amber-700", label: "⚠️ Partial" },
    failed: { bg: "bg-red-100", text: "text-red-700", label: "❌ Failed" },
    skipped_duplicate: { bg: "bg-slate-100", text: "text-slate-700", label: "⊘ Skipped" },
    merged_duplicate: { bg: "bg-purple-100", text: "text-purple-700", label: "🔗 Merged" }
  };
  const s = statusMap[status] || statusMap.failed;
  return <span className={`px-2 py-1 rounded text-xs font-semibold ${s.bg} ${s.text}`}>{s.label}</span>;
}

function CollapsibleSection({ title, icon, isOpen, onClick, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded overflow-hidden">
      <button
        onClick={onClick}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
      >
        <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
          <span>{icon}</span>
          {title}
        </h3>
        {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {isOpen && <div className="px-4 py-3 border-t border-slate-200">{children}</div>}
    </div>
  );
}

function ActivityDetailsPanel({ details }) {
  const [expanded, setExpanded] = useState({});

  const activityTypes = [...new Set(details.map(d => d.activity_type))];

  return (
    <div className="space-y-3">
      {activityTypes.map(type => {
        const typeDetails = details.filter(d => d.activity_type === type);
        const isOpen = expanded[type];
        return (
          <CollapsibleSection
            key={type}
            title={`${type.charAt(0).toUpperCase() + type.slice(1)}s (${typeDetails.length})`}
            icon={type === 'note' ? '📝' : type === 'call' ? '☎️' : type === 'email' ? '📧' : type === 'meeting' ? '📅' : '✓'}
            isOpen={isOpen}
            onClick={() => setExpanded(p => ({ ...p, [type]: !p[type] }))}
          >
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {typeDetails.map((detail, idx) => (
                <ActivityDetailItem key={idx} detail={detail} type={type} />
              ))}
            </div>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}

function ActivityDetailItem({ detail, type }) {
  return (
    <div className={`border rounded p-3 text-xs ${detail.sync_status === 'synced' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
      <div className="flex justify-between mb-1">
        <span className="font-semibold text-slate-800">{detail.lead_name || 'Unknown'}</span>
        <span className={detail.sync_status === 'synced' ? 'text-emerald-700' : 'text-red-700'}>
          {detail.sync_status === 'synced' ? '✅' : '❌'}
        </span>
      </div>
      {detail.subject && <div className="text-slate-700 mb-1">📋 {detail.subject}</div>}
      <div className="text-slate-600 space-y-0.5">
        <div>Owner: {detail.owner || '—'}</div>
        <div>Date: {detail.activity_date ? new Date(detail.activity_date).toLocaleString() : '—'}</div>
        {detail.error_message && <div className="text-red-600 font-semibold">Error: {detail.error_message}</div>}
      </div>
    </div>
  );
}