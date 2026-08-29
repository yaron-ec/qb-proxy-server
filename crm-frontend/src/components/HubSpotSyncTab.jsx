import { useState, useEffect, useCallback } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import {
  Database, Users, CheckCircle, Activity, ChevronDown, ChevronRight,
  UserCog, Loader2, X
} from "lucide-react";
import { SyncSection, SyncSectionHeader, SyncInfoNotice, SyncStatRow, SyncBtn, SyncResult, StatusPill } from "./SyncCard";
import OwnerMappingPanel from "./OwnerMappingPanel";

const SYNC_DISABLED_NOTE = "HubSpot sync was disabled after one-time migration. ContractorFlow is now the primary CRM.";
const MIGRATION_DATE = "June 1, 2026";

function fmtAbsTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export default function HubSpotSyncTab() {
  const [liveStats, setLiveStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [syncJobs, setSyncJobs] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [migrationResult, setMigrationResult] = useState(null);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [showReEnable, setShowReEnable] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const data = await railwayRequest('/hubspot/stats', {});
      if (data && !data.error) {
        setLiveStats(data);
        if (data.sync_jobs) setSyncJobs(data.sync_jobs);
      }
    } catch (e) { /* informational */ } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const runMigration = async () => {
    setMigrationRunning(true);
    setMigrationResult(null);
    try {
      const res = await railwayRequest('/hubspot/migrate-new-leads', {});
      setMigrationResult(res);
    } catch (e) {
      setMigrationResult({ error: e.message });
    } finally {
      setMigrationRunning(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">

      {/* ── Status banner (compact, not dark) ── */}
      <SyncSection>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
              <X className="w-4 h-4 text-slate-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">HubSpot Sync</span>
                <StatusPill status="inactive" />
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{SYNC_DISABLED_NOTE}</p>
            </div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400">
          Disabled: {MIGRATION_DATE} · All automations archived · Credentials preserved
        </div>
      </SyncSection>

      {/* ── Stat row ── */}
      <SyncSection>
        <SyncSectionHeader icon={Database} title="Data Overview" iconColor="text-slate-400" />
        {statsLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading stats...</div>
        ) : (
          <SyncStatRow items={[
            { label: "CRM Leads", value: liveStats?.crm_leads?.toLocaleString() ?? '—', color: "slate" },
            { label: "HubSpot Contacts", value: liveStats?.total_hubspot_contacts?.toLocaleString() ?? '—', color: "blue" },
            { label: "Matched", value: liveStats?.matched_contacts?.toLocaleString() ?? '—', color: "green" },
          ]} />
        )}
      </SyncSection>

      {/* ── One-Time Migration ── */}
      <SyncSection>
        <SyncSectionHeader
          icon={Database}
          title="One-Time Migration"
          iconColor="text-amber-500"
          badge={{ label: "Safe to re-run", className: "bg-slate-100 text-slate-500" }}
        />
        <p className="text-xs text-slate-500 mb-3">
          Protects all leads with status <strong className="text-slate-700">"New"</strong> from being overwritten by HubSpot.
          Sets <code className="bg-slate-100 px-1 rounded text-[10px]">hubspot_authoritative_fields = []</code> so no field is owned by HubSpot.
        </p>

        {migrationResult && !migrationResult.error && (
          <div className="mb-3">
            <SyncResult success message={`${migrationResult.updated} leads protected · ${migrationResult.failed} failed · ${migrationResult.total_found} total found`} />
          </div>
        )}
        {migrationResult?.error && (
          <div className="mb-3">
            <SyncResult success={false} error={migrationResult.error} />
          </div>
        )}

        <SyncBtn onClick={runMigration} disabled={migrationRunning} loading={migrationRunning} icon={CheckCircle}>
          {migrationRunning ? 'Running...' : 'Run Migration'}
        </SyncBtn>
      </SyncSection>

      {/* ── Sync History ── */}
      {syncJobs.length > 0 && (
        <SyncSection className="!p-0 overflow-hidden">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-semibold text-slate-700">Sync History</span>
              <span className="text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{syncJobs.length} runs</span>
            </div>
            {showHistory ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          </button>
          {showHistory && (
            <div className="border-t border-slate-100 divide-y divide-slate-50 max-h-72 overflow-y-auto">
              {syncJobs.map(job => <SyncJobRow key={job.id} job={job} />)}
            </div>
          )}
        </SyncSection>
      )}

      {/* ── Re-enable ── */}
      <SyncSection>
        <SyncSectionHeader icon={UserCog} title="Re-enable HubSpot Sync" iconColor="text-slate-400" />
        <p className="text-xs text-slate-500 mb-3">
          To re-enable automatic sync, create a new scheduled automation pointed at{" "}
          <code className="bg-slate-100 px-1 rounded text-[10px]">syncHubSpotContacts</code> in the Base44 dashboard.
          Credentials and API key are preserved.
        </p>
        {!showReEnable ? (
          <SyncBtn variant="secondary" onClick={() => setShowReEnable(true)}>How to re-enable →</SyncBtn>
        ) : (
          <SyncInfoNotice variant="neutral">
            <p className="font-semibold text-slate-700 mb-2">Steps to re-enable:</p>
            <ol className="space-y-1 list-decimal list-inside text-slate-600">
              <li>Go to Base44 Dashboard → Automations</li>
              <li>Create a new Scheduled automation</li>
              <li>Function: <code className="bg-slate-200 px-1 rounded">syncHubSpotContacts</code></li>
              <li>Interval: every 15 minutes</li>
              <li>The HUBSPOT_API_KEY secret is already set.</li>
            </ol>
            <button onClick={() => setShowReEnable(false)} className="mt-2 text-xs text-slate-400 hover:text-slate-600 font-semibold">Dismiss</button>
          </SyncInfoNotice>
        )}
      </SyncSection>

      {/* ── Owner Mapping ── */}
      <OwnerMappingPanel />
    </div>
  );
}

function SyncJobRow({ job }) {
  const cfg = {
    completed: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Completed" },
    failed:    { dot: "bg-red-500",     text: "text-red-700",     label: "Failed" },
    running:   { dot: "bg-amber-400 animate-pulse", text: "text-amber-700", label: "Running" },
  }[job.status] || { dot: "bg-slate-300", text: "text-slate-500", label: job.status };

  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-700 capitalize">{job.mode} sync</span>
          <span className={`text-[10px] font-bold ${cfg.text}`}>{cfg.label}</span>
        </div>
        <div className="text-[10px] text-slate-400 flex gap-3 mt-0.5">
          <span>{fmtAbsTime(job.started_at)}</span>
          {job.duration_ms && <span>· {fmtDuration(job.duration_ms)}</span>}
          {job.error_message && <span className="text-red-500 truncate">{job.error_message}</span>}
        </div>
      </div>
      {job.status === 'completed' && (
        <div className="text-right flex-shrink-0 text-[10px] text-slate-500 space-y-0.5">
          <div><span className="font-bold text-emerald-700">+{job.imported_count ?? 0}</span> new</div>
          <div><span className="font-bold text-blue-700">{job.updated_count ?? 0}</span> updated</div>
        </div>
      )}
    </div>
  );
}