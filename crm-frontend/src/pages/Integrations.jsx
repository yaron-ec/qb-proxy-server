import { useState, useEffect } from "react";
import * as railwayApi from "@/lib/railwayApi";
import * as railwayHandoffEstimates from "@/api/railway/handoffEstimates";
import { railwayRequest, normalizeIntegrationError } from "@/lib/railwayClient";
import { Link } from "react-router-dom";
import {
  ArrowLeft, CheckCircle, AlertTriangle, RefreshCw, RotateCcw, Loader2,
  Clock, Users, FileText, Receipt, AlertCircle, Unlink, Link as LinkIcon,
  ChevronDown, ChevronUp, Zap, Building2, Wifi, WifiOff, Activity
} from "lucide-react";
import { useSync } from "@/lib/syncContext";
import { useToast } from "@/components/ui/use-toast";
import IntegrationSyncStatus from "@/components/IntegrationSyncStatus";
import EstimateSyncDiagnostics from "@/components/EstimateSyncDiagnostics";
import CalendarSyncMonitor from "@/components/CalendarSyncMonitor";
import CalendarAuditPanel from "@/components/CalendarAuditPanel";
import MeetingPipelineAudit from "@/components/MeetingPipelineAudit";
import QBDiagnosticsPanel from "@/components/QBDiagnosticsPanel";
import UnmatchedEstimatesPanel, { isTestCustomer } from "@/components/UnmatchedEstimatesPanel";

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtRelative = (iso) => {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return fmtTime(iso);
};

export default function Integrations() {
  const { addJob, startJob, completeJob, failJob, isRunning, activeJobs } = useSync();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState(null);
  const [qbStatus, setQbStatus] = useState(null);
  const [company, setCompany] = useState(null);
  const [lastJob, setLastJob] = useState(null);
  const [failedLogs, setFailedLogs] = useState([]);
  const [recentLogs, setRecentLogs] = useState([]);
  const [stats, setStats] = useState({ customers: 0, estimates: 0, invoices: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncStage, setSyncStage] = useState(null);
  const [liveJobs, setLiveJobs] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [showErrors, setShowErrors] = useState(true);
  const [matchStats, setMatchStats] = useState({ matched: 0, needs_review: 0, failed: 0 });
  const [unmatchedRecords, setUnmatchedRecords] = useState([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [sendingReport, setSendingReport] = useState(false);

  useEffect(() => {
    railwayApi.me().then(r => setCurrentUser(r.user)).catch(() => {});
    loadAll();
    const interval = setInterval(() => {
      // QBSyncJob not yet on Railway — no live jobs polling
      setLiveJobs([]);
      loadSyncData();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadAll = async () => {
    setLoading(true);
    await Promise.allSettled([loadQBStatus(), loadSyncData()]);
    setLoading(false);
  };

  const loadQBStatus = async () => {
    try {
      const data = await railwayRequest('/qb/auth-status', {});
      setQbStatus(data);
      if (data?.connected) {
        const compData = await railwayRequest('/qb/get-company', {}).catch(() => ({}));
        setCompany(compData?.company);
      }
    } catch (e) { console.error(e); }
  };

  const loadSyncData = async () => {
    try {
      const [jobs, logs, allEstimates] = await Promise.all([
        Promise.resolve([]), // QBSyncJob — no Railway API yet
        Promise.resolve([]), // QBSyncLog — no Railway API yet
        railwayHandoffEstimates.list().then(r => r.items || []).catch(() => []),
      ]);
      setLastJob(jobs[0] || null);
      setFailedLogs(logs.filter(l => l.status === 'error'));
      setRecentLogs(logs.slice(0, 20));
      const successLogs = logs.filter(l => l.status === 'success');
      const uniqueCustomers = new Set(successLogs.filter(l => l.qb_type === 'Customer').map(l => l.entity_id)).size;
      const uniqueEstimates = new Set(successLogs.filter(l => l.qb_type === 'Estimate').map(l => l.entity_id)).size;
      const uniqueInvoices = new Set(successLogs.filter(l => l.qb_type === 'Invoice').map(l => l.entity_id)).size;
      setStats({ customers: uniqueCustomers, estimates: uniqueEstimates, invoices: uniqueInvoices });
      // Match stats from HandoffEstimate records
      const matched = allEstimates.filter(e => e.match_status === 'matched').length;
      const needs_review = allEstimates.filter(e => e.match_status === 'needs_review').length;
      const unmatched = allEstimates.filter(e => e.match_status === 'unmatched');
      // Exclude known test/demo customers from the actionable unmatched count
      const realUnmatched = unmatched.filter(e => !isTestCustomer(e.customer_name));
      setMatchStats({ matched, needs_review, failed: realUnmatched.length });
      setUnmatchedRecords(unmatched); // keep all for the panel (it filters internally)
    } catch (e) { console.error(e); }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/qb-callback`;
      const data = await railwayRequest('/qb/auth-connect', { redirectUri });
      const handleMessage = async (event) => {
        if (event.data?.type === 'QB_OAUTH_CODE') {
          window.removeEventListener('message', handleMessage);
          try {
            const { code, realmId } = event.data;
            const exchangeData = await railwayRequest('/qb/auth-callback', { code, realmId, redirectUri });
            if (exchangeData?.success) {
              toast({ title: 'QuickBooks connected', description: 'Successfully authorized', duration: 3000 });
              loadAll();
            } else {
              toast({ title: 'Connection failed', description: exchangeData?.error || 'Unknown error', variant: 'destructive', duration: 5000 });
            }
          } catch (e) {
            toast({ title: 'Token exchange failed', description: normalizeIntegrationError(e), variant: 'destructive', duration: 5000 });
          }
          setConnecting(false);
        }
      };
      window.addEventListener('message', handleMessage);
      const popup = window.open(data?.auth_url, 'qb_oauth', 'width=600,height=700');
      const timer = setInterval(() => {
        if (!popup || popup.closed) { clearInterval(timer); window.removeEventListener('message', handleMessage); setConnecting(false); }
      }, 500);
    } catch (e) { alert(normalizeIntegrationError(e)); setConnecting(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect QuickBooks?')) return;
    await railwayRequest('/qb/auth-disconnect', {}).catch(() => {});
    setQbStatus({ connected: false });
    setCompany(null);
  };

  const handleResyncAll = async (mode = 'all', forceFullResync = false) => {
    if (!qbStatus?.connected) {
      toast({ title: 'Not connected', description: 'Connect QuickBooks first.', variant: 'destructive', duration: 3000 });
      return;
    }
    if (isRunning('QuickBooks Full Sync')) {
      toast({ title: 'Sync already running', duration: 3000 });
      return;
    }
    if (forceFullResync) {
      const confirmed = window.confirm('Full Re-sync: This will re-fetch ALL records from QuickBooks from the beginning. This may take several minutes. Continue?');
      if (!confirmed) return;
    }
    const jobId = addJob('QB Re-sync All', 'QuickBooks Full Sync');
    startJob(jobId);
    setSyncing(true);
    setSyncStage('Connecting to QuickBooks...');
    try {
      setSyncStage(mode === 'customers' ? 'Fetching customers...' : mode === 'estimates' ? 'Fetching estimates...' : mode === 'invoices' ? 'Fetching invoices...' : 'Syncing all data...');
      const res = await railwayRequest('/qb/resync-all', { mode, triggered_by: 'manual', force_full: forceFullResync });
      if (!res?.success) throw new Error(res?.error || 'Sync failed to start');
      setSyncStage('Running in background...');
      completeJob(jobId);
      toast({ title: 'QuickBooks sync started', description: `Fetching ${mode === 'all' ? 'all records' : mode} from QuickBooks.`, duration: 4000 });
      setTimeout(() => { loadSyncData(); setSyncStage(null); }, 5000);
      setTimeout(() => loadSyncData(), 15000);
    } catch (e) {
      failJob(jobId, e.message);
      setSyncStage(null);
      toast({ title: 'Sync failed', description: e.message, variant: 'destructive', duration: 6000 });
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncEstimatesFromQB = async () => {
    if (isRunning('QB Estimate Import')) {
      toast({ title: 'Estimate sync already running', duration: 3000 });
      return;
    }
    const jobId = addJob('QB Est Import', 'QB Estimate Import');
    startJob(jobId);
    try {
      const res = await railwayRequest('/qb/import-estimates', { type: 'estimates' });
      if (!res?.success) throw new Error(res?.error || 'Import failed');
      const log = res?.log || {};
      completeJob(jobId);
      toast({
        title: 'Estimate import complete',
        description: `Found: ${log.estimates_found} · Imported: ${log.estimates_imported} · Matched: ${log.estimates_matched}`,
        duration: 5000,
      });
      setTimeout(() => loadSyncData(), 2000);
    } catch (e) {
      failJob(jobId, e.message);
      toast({ title: 'Estimate import failed', description: e.message, variant: 'destructive', duration: 5000 });
    }
  };

  const handleSendFailureReport = async () => {
    setSendingReport(true);
    try {
      const res = await railwayRequest('/qb/report-match-failures', {});
      if (res?.success) {
        toast({ title: 'Failure report sent', description: `${res.count} records reported to ${res.reported_to}`, duration: 4000 });
      } else {
        toast({ title: 'Report failed', description: res?.error || 'Unknown error', variant: 'destructive', duration: 5000 });
      }
    } catch (e) {
      toast({ title: 'Report failed', description: normalizeIntegrationError(e), variant: 'destructive', duration: 5000 });
    } finally {
      setSendingReport(false);
    }
  };

  const isConnected = qbStatus?.connected;
  const isSandbox = (qbStatus?.environment || '').toLowerCase() === 'sandbox';

  // Days until refresh token expires
  const tokenDaysLeft = qbStatus?.refresh_expires_at
    ? Math.floor((new Date(qbStatus.refresh_expires_at) - Date.now()) / 86400000)
    : null;
  const tokenWarning = tokenDaysLeft !== null && tokenDaysLeft <= 30;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/settings" className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-700 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Settings
          </Link>
          <span className="text-slate-200">/</span>
          <h1 className="text-sm font-bold text-slate-800">Integrations</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-3xl mx-auto w-full">

        {/* ── SANDBOX BANNER ── */}
        {isConnected && isSandbox && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-bold text-red-800">Connected to QuickBooks Sandbox — not Production</p>
              <p className="text-xs text-red-600 mt-1">Sync actions are disabled. Disconnect and reconnect to your Production account.</p>
              <button onClick={handleDisconnect} className="mt-3 flex items-center gap-1.5 text-xs font-bold text-red-700 border border-red-300 px-3 py-1.5 rounded-md hover:bg-red-100 transition-colors">
                <Unlink className="w-3.5 h-3.5" /> Disconnect Sandbox
              </button>
            </div>
          </div>
        )}

        {/* ── TOKEN EXPIRY WARNING ── */}
        {tokenWarning && (
          <div className={`rounded-lg p-4 flex items-center gap-3 border ${tokenDaysLeft < 7 ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
            <AlertTriangle className={`w-4 h-4 flex-shrink-0 ${tokenDaysLeft < 7 ? 'text-red-500' : 'text-amber-500'}`} />
            <p className={`text-xs font-semibold ${tokenDaysLeft < 7 ? 'text-red-700' : 'text-amber-700'}`}>
              QuickBooks connection expires in {tokenDaysLeft} day{tokenDaysLeft !== 1 ? 's' : ''} — reconnect to avoid interruptions.
            </p>
          </div>
        )}

        {/* ── LIVE SYNC BANNER ── */}
        {(liveJobs.length > 0 || (syncing && syncStage)) && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-blue-800">QuickBooks sync in progress</p>
              <p className="text-xs text-blue-600 mt-0.5">{syncStage || 'Running in background — this page refreshes automatically'}</p>
            </div>
          </div>
        )}

        {/* ── CARD 1: QB STATUS ── */}
        <div className="card-premium p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${isConnected && !isSandbox ? 'bg-emerald-100' : 'bg-slate-100'}`}>
                <Building2 className={`w-5 h-5 ${isConnected && !isSandbox ? 'text-emerald-600' : 'text-slate-400'}`} />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-sm font-bold text-slate-900">QuickBooks Online</h2>
                  {loading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                  ) : isConnected && !isSandbox ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">
                        <CheckCircle className="w-3 h-3" /> Connected
                      </span>
                      <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">Production</span>
                    </>
                  ) : isConnected && isSandbox ? (
                    <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold">Sandbox</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-semibold">
                      <WifiOff className="w-3 h-3" /> Disconnected
                    </span>
                  )}
                </div>

                {isConnected && company && (
                  <p className="text-sm font-semibold text-slate-700 mt-1">{company.CompanyName}</p>
                )}

                <div className="mt-1.5 space-y-0.5">
                  {isConnected ? (
                    <>
                      <p className="text-xs text-slate-500">Last sync: <span className="font-semibold text-slate-700">{fmtRelative(lastJob?.completed_at || lastJob?.started_at)}</span></p>
                      {qbStatus?.connected_at && (
                        <p className="text-xs text-slate-400">Connected {fmtRelative(qbStatus.connected_at)}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">Connect your QuickBooks account to enable data sync</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-shrink-0">
              {isConnected ? (
                <button
                  onClick={handleDisconnect}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-red-600 border border-slate-200 hover:border-red-200 px-3 py-2 rounded-lg hover:bg-red-50 transition-colors"
                >
                  <Unlink className="w-3.5 h-3.5" /> Reconnect
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="flex items-center gap-2 bg-orange text-white px-4 py-2 text-xs font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50"
                >
                  {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LinkIcon className="w-3.5 h-3.5" />}
                  Connect QuickBooks
                </button>
              )}
            </div>
          </div>

          {/* Metrics row */}
          {isConnected && (
            <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-slate-100">
              {[
                { label: 'Clients Synced', value: stats.customers, icon: <Users className="w-4 h-4" /> },
                { label: 'Estimates Synced', value: stats.estimates, icon: <FileText className="w-4 h-4" /> },
                { label: 'Invoices Synced', value: stats.invoices, icon: <Receipt className="w-4 h-4" /> },
              ].map(({ label, value, icon }) => (
                <div key={label} className="text-center">
                  <div className="text-xl font-black text-slate-800">{value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── MATCH SUMMARY CARD ── */}
        {isConnected && (
          <div className="card-premium overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">Estimate Match Summary</h3>
              <span className="text-xs text-slate-400">From QB sync</span>
            </div>
            <div className="grid grid-cols-3 gap-3 px-5 pb-4">
              <div className="text-center bg-emerald-50 rounded-lg p-3">
                <div className="text-2xl font-black text-emerald-700">{matchStats.matched}</div>
                <div className="text-xs font-semibold text-emerald-600 mt-0.5">Matched</div>
              </div>
              <div className="text-center bg-amber-50 rounded-lg p-3">
                <div className="text-2xl font-black text-amber-700">{matchStats.needs_review}</div>
                <div className="text-xs font-semibold text-amber-600 mt-0.5">Needs Review</div>
              </div>
              <div className="text-center bg-red-50 rounded-lg p-3">
                <div className="text-2xl font-black text-red-700">{matchStats.failed}</div>
                <div className="text-xs font-semibold text-red-600 mt-0.5">Unmatched</div>
              </div>
            </div>

            {matchStats.failed > 0 && (
              <div className="border-t border-slate-100">
                {/* Action buttons */}
                <div className="px-5 py-3 flex items-center gap-3">
                  <button
                    onClick={() => setShowUnmatched(!showUnmatched)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    {showUnmatched ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {showUnmatched ? 'Hide' : 'View'} {matchStats.failed} unmatched record{matchStats.failed !== 1 ? 's' : ''}
                  </button>
                  <button
                    onClick={handleSendFailureReport}
                    disabled={sendingReport}
                    className="flex items-center gap-1.5 text-xs font-semibold text-white bg-orange px-3 py-2 rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50"
                  >
                    {sendingReport ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    Send Failure Report
                  </button>
                </div>

                {/* Unmatched records — full review/match panel */}
                {showUnmatched && (
                  <div className="border-t border-slate-100">
                    <UnmatchedEstimatesPanel
                      records={unmatchedRecords}
                      currentUser={currentUser}
                      onRefresh={loadSyncData}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── CARD 2: SYNC ACTIONS ── */}
        {isConnected && !isSandbox && (
          <div className="card-premium p-5">
            <h3 className="text-sm font-bold text-slate-800 mb-4">Sync Actions</h3>
            <div className="grid grid-cols-2 gap-3">
              {/* Quick Sync */}
              <button
                onClick={() => handleResyncAll('all', false)}
                disabled={syncing}
                className="flex items-center gap-3 p-4 border border-slate-200 rounded-lg hover:border-orange hover:bg-orange/5 transition-all text-left disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-lg bg-orange/10 flex items-center justify-center flex-shrink-0">
                  <RefreshCw className={`w-4 h-4 text-orange ${syncing ? 'animate-spin' : ''}`} />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800">Quick Sync</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">New & updated records</p>
                </div>
              </button>

              {/* Import Estimates */}
              <button
                onClick={handleSyncEstimatesFromQB}
                disabled={syncing}
                className="flex items-center gap-3 p-4 border border-slate-200 rounded-lg hover:border-orange hover:bg-orange/5 transition-all text-left disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <Zap className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800">Import Estimates</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Pull all QB estimates</p>
                </div>
              </button>

              {/* Sync Customers */}
              <button
                onClick={() => handleResyncAll('customers', false)}
                disabled={syncing}
                className="flex items-center gap-3 p-4 border border-slate-200 rounded-lg hover:border-orange hover:bg-orange/5 transition-all text-left disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <Users className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800">Sync Customers</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Pull QB customer list</p>
                </div>
              </button>

              {/* Sync Invoices */}
              <button
                onClick={() => handleResyncAll('invoices', false)}
                disabled={syncing}
                className="flex items-center gap-3 p-4 border border-slate-200 rounded-lg hover:border-orange hover:bg-orange/5 transition-all text-left disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                  <Receipt className="w-4 h-4 text-purple-600" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800">Sync Invoices</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Pull QB invoices</p>
                </div>
              </button>
            </div>

            {/* Full re-sync row */}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <button
                onClick={() => handleResyncAll('all', true)}
                disabled={syncing}
                className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-red-600 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Full Re-sync (all records from beginning)
              </button>
            </div>
          </div>
        )}

        {/* ── CARD 3: RECENT SYNC ACTIVITY ── */}
        <div className="card-premium overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800">Recent Sync Activity</h3>
            {lastJob && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${lastJob.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : lastJob.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                {lastJob.status}
              </span>
            )}
          </div>

          {lastJob ? (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-5 gap-2">
                {[
                  { label: 'Customers', value: lastJob.customers_synced || 0, color: 'blue' },
                  { label: 'Estimates', value: lastJob.estimates_synced || 0, color: 'purple' },
                  { label: 'Invoices', value: lastJob.invoices_synced || 0, color: 'emerald' },
                  { label: 'From QB', value: lastJob.pulled_from_qb || 0, color: 'amber' },
                  { label: 'Failed', value: lastJob.failed_count || 0, color: 'red' },
                ].map(({ label, value, color }) => (
                  <MiniStat key={label} label={label} value={value} color={color} />
                ))}
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-400">
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtTime(lastJob.started_at)}</span>
                <span>Triggered by: <span className="font-semibold text-slate-600">{lastJob.triggered_by}</span></span>
              </div>
              {lastJob.error_summary && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">{lastJob.error_summary}</div>
              )}
            </div>
          ) : (
            <div className="p-6 text-center text-sm text-slate-400">No sync activity yet.</div>
          )}

          {/* Sync/API Failures — distinct from match failures */}
          {failedLogs.length > 0 && (
            <div className="border-t border-slate-100">
              <button
                onClick={() => setShowErrors(!showErrors)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-red-50 transition-colors"
              >
                <span className="text-xs font-bold text-red-700 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> {failedLogs.length} sync / API error{failedLogs.length !== 1 ? 's' : ''}
                </span>
                {showErrors ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
              </button>
              {showErrors && (
                <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {failedLogs.map(log => (
                    <div key={log.id} className="px-5 py-3 flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold text-slate-800">{log.entity_name || log.entity_id}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">{log.entity_type} · {fmtTime(log.created_date)}</p>
                        {log.error_message && <p className="text-[11px] text-red-600 mt-1">{log.error_message.slice(0, 120)}</p>}
                      </div>
                      <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold flex-shrink-0">Failed</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Audit log toggle */}
          <div className="border-t border-slate-100">
            <button
              onClick={() => setShowAuditLog(!showAuditLog)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Audit log (last 20 actions)
              </span>
              {showAuditLog ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
            </button>
            {showAuditLog && (
              <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                {recentLogs.length === 0 ? (
                  <div className="p-5 text-center text-xs text-slate-400">No activity yet.</div>
                ) : recentLogs.map(log => (
                  <div key={log.id} className="px-5 py-2.5 flex items-center gap-3">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${log.status === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-slate-700 mr-2 truncate">{log.entity_name || log.entity_id}</span>
                      <span className="text-[11px] text-slate-400">{log.entity_type}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <ActionBadge action={log.action} />
                      <span className="text-[11px] text-slate-400">{fmtRelative(log.created_date)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── CARD 4: ADVANCED DIAGNOSTICS (collapsed) ── */}
        <div className="card-premium overflow-hidden">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors"
          >
            <span className="text-sm font-bold text-slate-800">Advanced Diagnostics</span>
            {showAdvanced ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>
          {showAdvanced && (
            <div className="border-t border-slate-100 p-5 space-y-5">
              {/* Automation credits notice — admin-only, neutral */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <p className="text-xs font-semibold text-slate-600">Automation Status</p>
                <p className="text-xs text-slate-500 mt-1">Scheduled syncs and automation workflows require Integration Credits. If credits are exhausted, automations pause until credits reset. Manual sync actions on this page are unaffected.</p>
              </div>

              <QBDiagnosticsPanel qbStatus={qbStatus} company={company} isSandbox={isSandbox} isConnected={isConnected} />
              <MeetingPipelineAudit />
              <CalendarSyncMonitor />
              <CalendarAuditPanel />
              <IntegrationSyncStatus />
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-200 px-4 py-3">
                  <h3 className="text-xs font-bold text-slate-600 uppercase tracking-wide">Estimate Sync Flow (Handoff → QB → CRM)</h3>
                </div>
                <div className="p-4">
                  <EstimateSyncDiagnostics />
                </div>
              </div>

              {/* Full re-sync section */}
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Force Full Re-sync by Type</p>
                <div className="grid grid-cols-3 gap-2">
                  {['customers', 'estimates', 'invoices'].map(mode => (
                    <button
                      key={mode}
                      onClick={() => handleResyncAll(mode, true)}
                      disabled={syncing || !isConnected}
                      className="border border-red-200 text-red-600 rounded-lg px-3 py-2 text-xs font-semibold hover:bg-red-50 transition-colors disabled:opacity-50 capitalize"
                    >
                      Re-sync all {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* OAuth redirect URI */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-xs font-bold text-amber-800 mb-2">OAuth Redirect URI</p>
                <div className="bg-white border border-amber-200 rounded p-2.5 font-mono text-xs text-slate-700 break-all select-all">
                  {window.location.origin}/qb-callback
                </div>
                <p className="text-[11px] text-amber-600 mt-2">This URI must be registered exactly in the Intuit Developer Console and match QB_REDIRECT_URI on the proxy server.</p>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function MiniStat({ label, value, color }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-800',
    purple: 'bg-purple-50 text-purple-800',
    emerald: 'bg-emerald-50 text-emerald-800',
    amber: 'bg-amber-50 text-amber-800',
    red: 'bg-red-50 text-red-800',
  };
  return (
    <div className={`rounded-lg p-3 text-center ${colors[color]}`}>
      <div className="text-xl font-black">{value}</div>
      <div className="text-[11px] font-semibold mt-0.5 leading-tight">{label}</div>
    </div>
  );
}

function ActionBadge({ action }) {
  const map = {
    created:   'bg-emerald-100 text-emerald-700',
    imported:  'bg-emerald-100 text-emerald-700',
    updated:   'bg-blue-100 text-blue-700',
    pulled:    'bg-purple-100 text-purple-700',
    unchanged: 'bg-slate-100 text-slate-500',
    skipped:   'bg-slate-100 text-slate-600',
    failed:    'bg-red-100 text-red-700',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded-full font-semibold text-[10px] ${map[action] || map.skipped}`}>{action}</span>
  );
}