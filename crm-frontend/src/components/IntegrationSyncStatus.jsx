/**
 * IntegrationSyncStatus — Real-time sync status display for all integrations
 *
 * Shows:
 * - Current sync status (syncing / completed / failed)
 * - Last synced timestamp
 * - Records created/updated/skipped in last sync
 * - Retry indicators
 */

import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import {
  Loader2, CheckCircle, AlertTriangle, Clock, RotateCcw,
  ChevronDown, ChevronRight
} from "lucide-react";

const INTEGRATIONS = ["HubSpot", "QuickBooks", "Google Contacts", "Google Calendar"];

const fmtTime = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { 
    month: "short", 
    day: "numeric", 
    hour: "2-digit", 
    minute: "2-digit" 
  });
};

export default function IntegrationSyncStatus() {
  const [syncLogs, setSyncLogs] = useState({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [syncStates, setSyncStates] = useState({});

  useEffect(() => {
    loadSyncLogs();
    
    // Poll every 30 seconds for latest sync status
    const timer = setInterval(loadSyncLogs, 30000);
    
    return () => {
      clearInterval(timer);
    };
  }, []);

  const loadSyncLogs = async () => {
    try {
      const data = await apiCall('/api/v1/sync-cursors', { method: 'GET' });
      const logs = data.items || data || [];
      
      // Group by integration, get latest of each
      const grouped = {};
      for (const log of logs) {
        if (!grouped[log.integration_name] || new Date(log.start_time) > new Date(grouped[log.integration_name].start_time)) {
          grouped[log.integration_name] = log;
        }
      }
      
      setSyncLogs(grouped);
      setLoading(false);
      
      // Check if any are currently syncing
      const syncing = {};
      for (const name of INTEGRATIONS) {
        const log = grouped[name];
        const now = Date.now();
        const startTime = log ? new Date(log.start_time).getTime() : 0;
        const duration = log?.duration_ms || 0;
        
        // Consider "syncing" if started in last 2 minutes and duration < 90 seconds
        syncing[name] = (now - startTime < 120000) && duration < 90000 && !log?.end_time;
      }
      setSyncStates(syncing);
    } catch (e) {
      console.error('[SyncStatus] Error loading logs:', e);
    }
  };

  const getLatestLog = (integrationName) => {
    return syncLogs[integrationName];
  };

  const toggleCollapsed = (name) => {
    setCollapsed(prev => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className="bg-white rounded border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-bold text-slate-800">⚡ Auto-Sync Status (Every 15 Min)</h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-4 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading sync status...
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {INTEGRATIONS.map(name => {
            const log = getLatestLog(name);
            const isSyncing = syncStates[name];
            const isDone = log?.status === 'success';
            const isFailed = log?.status === 'failed';
            
            return (
              <div key={name} className="p-3">
                <button
                  onClick={() => toggleCollapsed(name)}
                  className="w-full flex items-center gap-3 hover:bg-slate-50 transition-colors rounded px-1 py-0.5"
                >
                  {collapsed[name] ? (
                    <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
                  )}
                  
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800">{name}</span>
                      {isSyncing && (
                        <span className="flex items-center gap-1 text-[10px] text-blue-600 font-bold">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Syncing...
                        </span>
                      )}
                      {isDone && (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-bold">
                          <CheckCircle className="w-2.5 h-2.5" /> OK
                        </span>
                      )}
                      {isFailed && (
                        <span className="flex items-center gap-1 text-[10px] text-red-600 font-bold">
                          <AlertTriangle className="w-2.5 h-2.5" /> Failed
                        </span>
                      )}
                    </div>
                    
                    {log && (
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {fmtTime(log.start_time)}
                        </span>
                      </div>
                    )}
                  </div>

                  {log && !isSyncing && (
                    <div className="text-right text-[10px] text-slate-600 font-semibold flex-shrink-0">
                      <div>+{log.created_count || 0} · ✎{log.updated_count || 0}</div>
                      {log.duration_ms && <div className="text-slate-400">{(log.duration_ms / 1000).toFixed(1)}s</div>}
                    </div>
                  )}
                </button>

                {!collapsed[name] && log && (
                  <div className="mt-2 ml-6 space-y-1 text-xs text-slate-600">
                    <div>Status: <span className="font-semibold text-slate-800">{log.status}</span></div>
                    <div>Created: <span className="font-semibold text-emerald-600">{log.created_count || 0}</span></div>
                    <div>Updated: <span className="font-semibold text-blue-600">{log.updated_count || 0}</span></div>
                    <div>Skipped: <span className="font-semibold text-amber-600">{log.skipped_count || 0}</span></div>
                    <div>Duration: <span className="font-semibold text-slate-700">{(log.duration_ms / 1000).toFixed(1)}s</span></div>
                    <div>Attempt: <span className="font-semibold text-slate-700">{log.retry_attempt || 1}</span></div>
                    
                    {log.error_message && (
                      <div className="mt-1 p-1.5 bg-red-50 border border-red-200 rounded">
                        <div className="text-red-700 font-semibold">⚠️ Error</div>
                        <div className="text-red-600 break-all text-[9px] mt-0.5">{log.error_message}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-slate-50 border-t border-slate-200 px-4 py-2">
        <button
          onClick={loadSyncLogs}
          className="text-xs text-blue-600 hover:underline font-semibold flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" /> Refresh
        </button>
      </div>
    </div>
  );
}