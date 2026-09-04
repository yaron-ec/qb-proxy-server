import { useState, useEffect, useRef } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import * as railwayLeads from "@/api/railway/leads";
import { apiCall } from "@/api/railway/client";
import {
  CheckCircle, AlertTriangle, Loader2, Link, Unlink, RefreshCw,
  ArrowRight, Clock, Database, Zap, FileDown, Receipt, FileText
} from "lucide-react";
import { useSync } from "@/lib/syncContext";
import { useToast } from "@/components/ui/use-toast";
import { SyncSection, SyncSectionHeader, SyncInfoNotice, SyncStatRow, SyncBtn, StatusPill } from "./SyncCard";
import QBEnvironmentSelector from "./QBEnvironmentSelector";

export default function QuickBooksSyncTab() {
  const { addJob, startJob, completeJob, failJob, isRunning } = useSync();
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [company, setCompany] = useState(null);
  const [syncResults, setSyncResults] = useState([]);
  const [connectDebug, setConnectDebug] = useState(null);
  const [connectError, setConnectError] = useState(null);

  const [leads, setLeads] = useState([]);
  const [estimates, setEstimates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [importSyncing, setImportSyncing] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [histImporting, setHistImporting] = useState(false);
  const [histResult, setHistResult] = useState(null);

  // Refs for OAuth popup cleanup — prevents stale postMessage listeners
  // from surviving unmount and re-setting connectError on a new mount.
  const onMessageRef = useRef(null);
  const popupTimerRef = useRef(null);

  // Cleanup any stale OAuth listeners on unmount.
  useEffect(() => {
    return () => {
      if (onMessageRef.current) window.removeEventListener('message', onMessageRef.current);
      if (popupTimerRef.current) clearInterval(popupTimerRef.current);
    };
  }, []);

  useEffect(() => { loadStatus(); }, []);

  const loadStatus = async () => {
    setLoading(true);
    setLoadError(null);
    setConnectError(null);
    try {
      const res = await railwayRequest('/qb/auth-status');
      setStatus(res);
      if (res?.connected) loadCompany();
    } catch (e) {
      const is404 = e.message?.includes('404') || e.response?.status === 404;
      setLoadError(is404 ? 'QuickBooks service route not deployed. Check that the "qbAuth" backend function exists.' : `Connection Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Railway: company info via proxy /qb/get-company (no Base44 function credit on page load).
  // TODO(qbSync→Railway): manual sync actions below (resync_all, sync_customer/estimate/invoice,
  //   refresh_invoice, void_invoice, reconnect_customer, diagnose_customer) still call the
  //   Base44 `qbSync` function. Railway /qb/resync-all returns raw QB data only and does NOT
  //   perform lead matching or CRM entity writes. Do NOT route these manual buttons to Railway
  //   until that matching+write logic is ported (using the Base44 entity REST API), or sync
  //   will silently break.
  const loadCompany = async () => {
    try {
      const data = await railwayRequest('/qb/get-company');
      setCompany(data?.company);
    } catch (e) { /* silent — company name is non-critical */ }
  };

  const handleConnect = async () => {
    if (isRunning('QuickBooks OAuth')) return;
    setActionLoading(true);
    setConnectDebug(null);
    setConnectError(null);
    const jobId = addJob('QuickBooks OAuth', 'QuickBooks OAuth');
    startJob(jobId);
    try {
      const redirectUri = `${window.location.origin}/qb-callback`;
      const res = await railwayRequest('/qb/auth-connect', { redirect_uri: redirectUri });
      const authUrl = res?.auth_url;
      if (res?.debug) setConnectDebug(res.debug);
      if (!authUrl) throw new Error(res?.error || 'No auth URL returned from backend');
      const onMessage = async (event) => {
        if (event.data?.type === 'QB_OAUTH_CODE') {
          window.removeEventListener('message', onMessage);
          onMessageRef.current = null;
          clearInterval(timer);
          popupTimerRef.current = null;
          try {
            const cbRes = await railwayRequest('/qb/auth-callback', { code: event.data.code, realmId: event.data.realmId, redirect_uri: redirectUri });
            if (cbRes?.error) { setConnectError(`Token exchange failed: ${cbRes.error}`); failJob(jobId, cbRes.error); }
            else { completeJob(jobId); loadStatus(); }
          } catch (e) { setConnectError(`Token exchange error: ${e.message}`); failJob(jobId, e.message); }
          setActionLoading(false);
        }
      };
      onMessageRef.current = onMessage;
      window.addEventListener('message', onMessage);
      const popup = window.open(authUrl, 'qb_oauth', 'width=600,height=700');
      const timer = setInterval(() => {
        if (!popup || popup.closed) { clearInterval(timer); window.removeEventListener('message', onMessage); onMessageRef.current = null; popupTimerRef.current = null; loadStatus(); setActionLoading(false); }
      }, 500);
      popupTimerRef.current = timer;
    } catch (e) { setConnectError(e.message); failJob(jobId, e.message); setActionLoading(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect QuickBooks? This will remove stored tokens.')) return;
    setActionLoading(true);
    try {
      await railwayRequest('/qb/auth-disconnect');
      setStatus({ connected: false });
      setCompany(null);
    } catch (e) { alert('Error: ' + e.message); }
    finally { setActionLoading(false); }
  };

  const loadPanel = async (panel) => {
    setActivePanel(panel);
    setDataLoading(true);
    try {
      if (panel === 'customers') { const data = await railwayLeads.list({ sort: '-created_date', limit: 50 }).then(r => r.items || []); setLeads(data); }
      else if (panel === 'estimates') { const data = await apiCall('/api/v1/estimates?sort=-created_date&limit=50').then(r => r.items || []).catch(() => []); setEstimates(data); }
      else if (panel === 'invoices') { const data = await apiCall('/api/v1/projects?sort=-created_date&limit=50').then(r => r.items || []).catch(() => []); setProjects(data); }
    } catch (e) { /* */ } finally { setDataLoading(false); }
  };

  const syncItem = async (action, id, label) => {
    const key = `${action}_${id}`;
    setSyncResults(prev => [...prev.filter(r => r.key !== key), { key, label, status: 'queued' }]);
    const jobId = addJob(`QB: ${label}`, 'QuickBooks');
    startJob(jobId);
    const payload = action === 'sync_customer' ? { action, leadId: id } : action === 'sync_estimate' ? { action, estimateId: id } : { action, projectId: id };
    railwayRequest('/qb/sync-lead', payload)
      .then(res => {
        if (res.data?.success || res.status === 202) { setSyncResults(prev => prev.map(r => r.key === key ? { ...r, status: 'queued' } : r)); completeJob(jobId); toast({ title: `${label} queued`, description: 'Sync running in background.', dedup_key: `qb_sync_${id}` }); }
        else if (res.data?.error) { setSyncResults(prev => prev.map(r => r.key === key ? { ...r, status: 'error', error: res.data.error } : r)); failJob(jobId, res.data.error); }
      })
      .catch(e => { setSyncResults(prev => prev.map(r => r.key === key ? { ...r, status: 'error', error: e.message } : r)); failJob(jobId, e.message); });
  };

  const handleBulkSync = async (forceFullResync = false) => {
    setBulkSyncing(true);
    setBulkResult(null);
    const jobId = addJob('QuickBooks Sync', 'QuickBooks');
    startJob(jobId);
    try {
      const res = await railwayRequest('/sync/qb-estimates', { action: 'resync_all', mode: 'all', force_full: forceFullResync, triggered_by: 'manual' });
      const data = res.data;
      if (data?.connection_error) { setBulkResult({ success: false, error: data.message || data.error || 'QB connection error. Please reconnect.' }); failJob(jobId, data.message || data.error); loadStatus(); }
      else if (!data?.success) { const msg = data?.error || 'Sync failed.'; setBulkResult({ success: false, error: msg }); failJob(jobId, msg); }
      else { setBulkResult({ success: true, message: data.message }); completeJob(jobId); toast({ title: 'QuickBooks sync complete', description: data.message }); }
    } catch (e) {
      const isConn = e?.response?.data?.connection_error;
      const errMsg = isConn ? (e?.response?.data?.message || 'QB connection expired. Please reconnect.') : (e?.response?.data?.error || e.message || 'Sync failed');
      setBulkResult({ success: false, error: errMsg }); failJob(jobId, errMsg); if (isConn) loadStatus();
    } finally { setBulkSyncing(false); }
  };

  const getItemStatus = (action, id) => syncResults.find(r => r.key === `${action}_${id}`)?.status;

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-8 text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking QuickBooks connection...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-xl">
        <SyncInfoNotice variant="red">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-500" />
            <div>
              <p className="font-semibold mb-1">QuickBooks Service Unavailable</p>
              <p className="font-mono text-[10px] break-all">{loadError}</p>
              <SyncBtn className="mt-3" variant="secondary" onClick={loadStatus} icon={RefreshCw}>Retry</SyncBtn>
            </div>
          </div>
        </SyncInfoNotice>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">

      {/* ── Environment selector ── */}
      <QBEnvironmentSelector />

      {/* ── Connection card ── */}
      <SyncSection>
        <SyncSectionHeader
          icon={status?.connected ? CheckCircle : AlertTriangle}
          title="QuickBooks Connection"
          iconColor={status?.connected ? "text-emerald-500" : "text-amber-500"}
          badge={status?.connected
            ? { label: "Connected", className: "bg-emerald-100 text-emerald-700" }
            : { label: "Not Connected", className: "bg-slate-100 text-slate-500" }}
          action={
            status?.connected ? (
              <div className="flex items-center gap-2">
                <SyncBtn variant="secondary" onClick={handleConnect} disabled={actionLoading} loading={actionLoading} icon={RefreshCw}>Reconnect</SyncBtn>
                <SyncBtn variant="danger" onClick={handleDisconnect} disabled={actionLoading} icon={Unlink}>Disconnect</SyncBtn>
              </div>
            ) : (
              <SyncBtn onClick={handleConnect} disabled={actionLoading} loading={actionLoading} icon={Link}
                className="bg-[#2CA01C] hover:bg-[#249016] text-white border-0">
                Connect QuickBooks
              </SyncBtn>
            )
          }
        />

        {status?.connected && (
          <>
            {company && <p className="text-xs text-slate-600 font-semibold mb-1">{company.CompanyName}</p>}
            <p className="text-[10px] text-slate-400">
              Realm ID: {status.realm_id}
              {status.connected_at && ` · Connected ${new Date(status.connected_at).toLocaleDateString()}`}
            </p>
            {company?.CompanyName?.toLowerCase().includes('sandbox') && (
              <SyncInfoNotice variant="amber" className="mt-3">
                <span className="font-semibold">Sandbox connected.</span> To use live data, select "Production" above and reconnect.
              </SyncInfoNotice>
            )}
          </>
        )}

        {!status?.connected && (
          <p className="text-xs text-slate-500">Connect your QuickBooks Online account to start syncing leads, estimates, and invoices.</p>
        )}

        {connectError && (
          <SyncInfoNotice variant="red" className="mt-3">
            <span className="font-semibold">Connection error:</span> {connectError}
          </SyncInfoNotice>
        )}
      </SyncSection>

      {/* ── Sync panels (connected only) ── */}
      {status?.connected && (
        <>
          {/* What gets synced */}
          <SyncInfoNotice variant="blue">
            <p className="font-semibold text-slate-700 mb-1">What gets synced</p>
            <ul className="space-y-0.5 text-slate-500">
              <li>• <strong className="text-slate-700">Leads → Customers</strong> — creates/updates QB customers from CRM leads</li>
              <li>• <strong className="text-slate-700">Estimates → QB Estimates</strong> — syncs line items, totals, and status</li>
              <li>• <strong className="text-slate-700">Projects → Invoices</strong> — creates QB invoices from project contract values</li>
            </ul>
          </SyncInfoNotice>

          {/* Bulk sync */}
          <SyncSection>
            <SyncSectionHeader icon={RefreshCw} title="Sync from QuickBooks" iconColor="text-amber-500"
              action={
                <div className="flex items-center gap-2">
                  <SyncBtn onClick={() => handleBulkSync(false)} disabled={bulkSyncing} loading={bulkSyncing} icon={Zap}>
                    {bulkSyncing ? 'Syncing...' : 'Quick Sync'}
                  </SyncBtn>
                  <SyncBtn variant="secondary" onClick={() => handleBulkSync(true)} disabled={bulkSyncing} icon={Database}>
                    Full Re-sync
                  </SyncBtn>
                </div>
              }
            />
            <p className="text-xs text-slate-500">Pull latest customers, estimates &amp; invoices from QuickBooks.</p>
            {bulkSyncing && (
              <SyncInfoNotice variant="blue" className="mt-3">
                <div className="flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 flex-shrink-0" /> Syncing QuickBooks data... this may take a minute.</div>
              </SyncInfoNotice>
            )}
            {bulkResult && !bulkSyncing && (
              <div className="mt-3">
                {bulkResult.success
                  ? <SyncInfoNotice variant="green"><span className="font-semibold">✓ {bulkResult.message || 'Sync completed successfully.'}</span></SyncInfoNotice>
                  : <SyncInfoNotice variant="red"><span className="font-semibold">Error: {bulkResult.error}</span></SyncInfoNotice>}
              </div>
            )}
          </SyncSection>

          {/* Import Estimates from QB */}
          <SyncSection>
            <SyncSectionHeader icon={FileText} title="Import QB Estimates" iconColor="text-amber-500"
              action={
                <SyncBtn onClick={async () => {
                  setHistImporting(true); setHistResult(null);
                  const jobId = addJob('QB Historical Estimates Import', 'QuickBooks'); startJob(jobId);
                  try {
                    const res = await railwayRequest('/qb/import-estimates', {});
                    if (!res.data?.success) throw new Error(res.data?.error || 'Import failed');
                    setHistResult({ success: true, log: res.data.log }); completeJob(jobId);
                    toast({ title: 'QB Estimates Imported', description: `${res.data.log.imported} new · ${res.data.log.updated} updated` });
                  } catch (e) { setHistResult({ success: false, error: e?.response?.data?.error || e.message }); failJob(jobId, e.message); }
                  finally { setHistImporting(false); }
                }} disabled={histImporting} loading={histImporting} icon={FileDown}>
                  {histImporting ? 'Importing...' : 'Import Estimates'}
                </SyncBtn>
              }
            />
            <p className="text-xs text-slate-500">Fetch all estimates from QB and import into CRM. Deduplicates by QB ID.</p>
            {histResult && (
              <div className="mt-3">
                {histResult.success ? (
                  <SyncInfoNotice variant="green">
                    <div className="flex items-center gap-2 font-semibold mb-2"><CheckCircle className="w-3.5 h-3.5" /> Import complete</div>
                    {histResult.log && (
                      <SyncStatRow items={[
                        { label: "Found in QB", value: histResult.log.fetched, color: "slate" },
                        { label: "Imported", value: histResult.log.imported, color: "green" },
                        { label: "Updated", value: histResult.log.updated, color: "blue" },
                        { label: "Matched", value: histResult.log.matched, color: "green" },
                        { label: "Unmatched", value: histResult.log.unmatched, color: histResult.log.unmatched > 0 ? "amber" : "slate" },
                        { label: "Skipped", value: histResult.log.skipped, color: "slate" },
                      ]} />
                    )}
                  </SyncInfoNotice>
                ) : (
                  <SyncInfoNotice variant="red"><span className="font-semibold">Error: {histResult.error}</span></SyncInfoNotice>
                )}
              </div>
            )}
          </SyncSection>

          {/* Import Transactions */}
          <SyncSection>
            <SyncSectionHeader icon={FileDown} title="Import QB Transactions" iconColor="text-blue-500" />
            <p className="text-xs text-slate-500 mb-3">Estimates → Handoff Estimates · Invoices (PDF) → Attachments · Payments → Timeline</p>
            <div className="flex flex-wrap gap-2">
              {[
                { type: 'all',       label: 'All',      icon: Database,    variant: 'primary' },
                { type: 'estimates', label: 'Estimates', icon: FileText,   variant: 'secondary' },
                { type: 'invoices',  label: 'Invoices',  icon: Receipt,    variant: 'secondary' },
                { type: 'payments',  label: 'Payments',  icon: CheckCircle, variant: 'secondary' },
              ].map(btn => (
                <SyncBtn key={btn.type} variant={btn.variant} icon={btn.icon} disabled={importSyncing}
                  loading={importSyncing} onClick={async () => {
                    setImportSyncing(true); setImportResult(null);
                    const jobId = addJob(`QB Import: ${btn.type}`, 'QuickBooks'); startJob(jobId);
                    try {
                      const res = await railwayRequest('/sync/qb-estimates', { type: btn.type, force_full: false });
                      if (!res.data?.success) throw new Error(res.data?.error || 'Import failed');
                      setImportResult({ success: true, log: res.data.log }); completeJob(jobId);
                    } catch (e) { setImportResult({ success: false, error: e?.response?.data?.error || e.message }); failJob(jobId, e.message); }
                    finally { setImportSyncing(false); }
                  }}>
                  {btn.label}
                </SyncBtn>
              ))}
            </div>
            {importSyncing && (
              <SyncInfoNotice variant="blue" className="mt-3">
                <div className="flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" /> Importing QB transactions...</div>
              </SyncInfoNotice>
            )}
            {importResult && !importSyncing && (
              <div className="mt-3">
                {importResult.success
                  ? <SyncInfoNotice variant="green"><span className="font-semibold">✓ Import complete</span></SyncInfoNotice>
                  : <SyncInfoNotice variant="red"><span className="font-semibold">Error: {importResult.error}</span></SyncInfoNotice>}
              </div>
            )}
          </SyncSection>

          {/* Individual sync panels */}
          <SyncSection>
            <SyncSectionHeader icon={ArrowRight} title="Sync Individual Records" iconColor="text-slate-400" />
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[
                { key: 'customers', label: '👤 Leads', sub: 'as QB Customers' },
                { key: 'estimates', label: '📋 Estimates', sub: 'as QB Estimates' },
                { key: 'invoices',  label: '🧾 Projects', sub: 'as QB Invoices' },
              ].map(panel => (
                <button key={panel.key} onClick={() => loadPanel(panel.key)}
                  className={`text-left border rounded-lg p-3 transition-all text-xs ${
                    activePanel === panel.key ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}>
                  <div className="font-semibold text-slate-800">{panel.label}</div>
                  <div className="text-slate-400 mt-0.5">{panel.sub}</div>
                </button>
              ))}
            </div>

            {activePanel && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">
                    {activePanel === 'customers' ? 'Leads → QB Customers' : activePanel === 'estimates' ? 'Estimates → QB Estimates' : 'Projects → QB Invoices'}
                  </span>
                  <button onClick={() => setActivePanel(null)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
                </div>
                {dataLoading ? (
                  <div className="flex items-center gap-2 p-5 text-slate-400 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
                ) : (
                  <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                    {activePanel === 'customers' && leads.map(lead => (
                      <SyncRow key={lead.id} label={`${lead.first_name} ${lead.last_name}`} sub={lead.email || lead.phone || ''} status={getItemStatus('sync_customer', lead.id)} onSync={() => syncItem('sync_customer', lead.id, `${lead.first_name} ${lead.last_name}`)} />
                    ))}
                    {activePanel === 'estimates' && estimates.map(est => (
                      <SyncRow key={est.id} label={est.title} sub={`${est.status} · $${(est.total || 0).toLocaleString()}`} status={getItemStatus('sync_estimate', est.id)} onSync={() => syncItem('sync_estimate', est.id, est.title)} />
                    ))}
                    {activePanel === 'invoices' && projects.map(proj => (
                      <SyncRow key={proj.id} label={proj.name} sub={`${proj.client_name} · $${(proj.contract_value || 0).toLocaleString()}`} status={getItemStatus('sync_invoice', proj.id)} onSync={() => syncItem('sync_invoice', proj.id, proj.name)} />
                    ))}
                    {((activePanel === 'customers' && !leads.length) || (activePanel === 'estimates' && !estimates.length) || (activePanel === 'invoices' && !projects.length)) && (
                      <div className="p-5 text-center text-xs text-slate-400">No records found.</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </SyncSection>
        </>
      )}
    </div>
  );
}

function SyncRow({ label, sub, status, onSync }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50">
      <div>
        <div className="text-xs font-semibold text-slate-800">{label}</div>
        {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
      </div>
      <div className="flex items-center gap-2">
        {status === 'queued' && <span className="text-[10px] text-blue-600 font-semibold flex items-center gap-1"><Clock className="w-3 h-3" /> Queued</span>}
        {status === 'error'  && <span className="text-[10px] text-red-500 font-semibold">Failed</span>}
        <SyncBtn variant="secondary" onClick={onSync} disabled={status === 'syncing' || status === 'queued'} icon={RefreshCw}>
          {status === 'syncing' ? 'Syncing...' : status === 'queued' ? 'Queued' : 'Sync'}
        </SyncBtn>
      </div>
    </div>
  );
}