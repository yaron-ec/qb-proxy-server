/**
 * HandoffQBDebugger — Visual debugging tool for Handoff → QB sync issues
 */

import { useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, 
  CheckCircle, AlertCircle, Zap
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

export default function HandoffQBDebugger() {
  const [debug, setDebug] = useState(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  const { toast } = useToast();

  const runDebug = async () => {
    setLoading(true);
    try {
      const res = await railwayRequest('/handoff/debug-qb-flow', {});
      setDebug(res.debug);
      
      // Also check Handoff connection
      const handoffRes = await railwayRequest('/handoff/auth', { action: 'status' });
      if (handoffRes) {
        setDebug(prev => ({
          ...prev,
          handoff_connection: handoffRes,
        }));
      }

      setCollapsed(false);
      setExpandedSections({});
      toast({
        title: 'Debug report generated',
        description: 'Check the issues and logs below',
        dedup_key: 'handoff_debug',
      });
    } catch (e) {
      toast({
        title: 'Debug failed',
        description: e.message,
        variant: 'destructive',
        dedup_key: 'handoff_debug',
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleSection = (key) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (!debug) {
    return (
      <div className="border border-slate-200 rounded-lg bg-white p-6 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-orange" />
          <h3 className="text-sm font-bold text-slate-800">Debug Handoff → QB Flow</h3>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Run a detailed diagnostic to identify why Handoff estimates aren't syncing to QuickBooks
        </p>
        <button
          onClick={runDebug}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-orange text-white px-4 py-2 text-xs font-bold rounded hover:bg-orange/90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {loading ? 'Running...' : 'Start Debug'}
        </button>
      </div>
    );
  }

  const d = debug;
  const issues = d.sections?.diagnosis?.potential_issues || [];
  const hasIssues = issues.some(i => i.includes('❌'));

  return (
    <div className={`border rounded-lg ${hasIssues ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:opacity-90"
      >
        <div className="flex items-center gap-3">
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <div className="flex items-center gap-2">
            {hasIssues ? (
              <AlertTriangle className="w-4 h-4 text-red-600" />
            ) : (
              <CheckCircle className="w-4 h-4 text-emerald-600" />
            )}
            <span className={`text-sm font-bold ${hasIssues ? 'text-red-800' : 'text-emerald-800'}`}>
              Debug Report: {hasIssues ? 'Issues Found' : 'No Issues'}
            </span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            runDebug();
          }}
          disabled={loading}
          className="text-xs text-blue-600 hover:text-blue-700 font-bold disabled:opacity-50"
        >
          {loading ? 'Running...' : 'Refresh'}
        </button>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3 border-t border-current border-opacity-10 mt-3">

          {/* Handoff Connection Status */}
          {d.handoff_connection && (
            <div className={`rounded p-3 ${d.handoff_connection.connected ? 'bg-emerald-100 border border-emerald-200' : 'bg-red-100 border border-red-200'}`}>
              <div className="flex items-center gap-2 mb-1">
                {d.handoff_connection.connected ? (
                  <CheckCircle className="w-4 h-4 text-emerald-700" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-700" />
                )}
                <span className={`text-sm font-bold ${d.handoff_connection.connected ? 'text-emerald-800' : 'text-red-800'}`}>
                  Handoff API {d.handoff_connection.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              {!d.handoff_connection.connected && (
                <div className={`text-xs ${d.handoff_connection.reason ? 'text-red-700' : 'text-red-600'}`}>
                  {d.handoff_connection.reason || 'API authentication failed'}
                </div>
              )}
              {d.handoff_connection.last_tested && (
                <div className="text-[9px] text-slate-600 mt-1">
                  Tested: {new Date(d.handoff_connection.last_tested).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {/* Issues Summary */}
          {issues.length > 0 && (
            <div className="bg-white/60 rounded p-3 space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Found {issues.length} Issue{issues.length > 1 ? 's' : ''}</div>
              {issues.map((issue, i) => (
                <div key={i} className={`text-[11px] font-semibold ${
                  issue.includes('❌') ? 'text-red-700' : 
                  issue.includes('⚠️') ? 'text-amber-700' :
                  'text-emerald-700'
                }`}>
                  {issue}
                </div>
              ))}
            </div>
          )}

          {/* Sync Queue Status */}
          {d.sections?.sync_queue && (
            <Section 
              title="Webhook Activity (Sync Queue)" 
              icon={<Zap className="w-3.5 h-3.5" />}
              expanded={expandedSections.queue}
              onToggle={() => toggleSection('queue')}
            >
              <div className="space-y-2">
                <Stat label="Total items received" value={d.sections.sync_queue.total_items} />
                <div className="bg-slate-100 rounded p-2 text-[10px] font-mono text-slate-700">
                  {Object.entries(d.sections.sync_queue.breakdown_by_status).map(([status, count]) => (
                    <div key={status}>{status}: {count}</div>
                  ))}
                </div>
                
                {d.sections.sync_queue.recent_items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-bold text-slate-600 mb-1">Recent items:</div>
                    <div className="space-y-1">
                      {d.sections.sync_queue.recent_items.slice(0, 3).map(item => (
                        <div key={item.id} className="bg-slate-100 rounded p-2 text-[9px]">
                          <div className="font-bold">{item.event_type} · <span className={
                            item.status === 'completed' ? 'text-emerald-600' :
                            item.status === 'failed' ? 'text-red-600' :
                            'text-amber-600'
                          }>{item.status}</span></div>
                          <div className="text-slate-600 mt-0.5">{item.push_indicator}</div>
                          {item.error_message && <div className="text-red-600 mt-0.5">❌ {item.error_message}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Handoff Estimates Status */}
          {d.sections?.handoff_estimates && (
            <Section 
              title="Handoff Estimates in Base44" 
              icon={<CheckCircle className="w-3.5 h-3.5" />}
              expanded={expandedSections.estimates}
              onToggle={() => toggleSection('estimates')}
            >
              <div className="space-y-2">
                <Stat label="Total estimates" value={d.sections.handoff_estimates.total} />
                
                <div>
                  <div className="text-[10px] font-bold text-slate-600 mb-1">By Status:</div>
                  <div className="bg-slate-100 rounded p-2 text-[10px] font-mono text-slate-700 space-y-0.5">
                    {Object.entries(d.sections.handoff_estimates.breakdown_by_status).map(([status, count]) => (
                      <div key={status}>{status}: {count}</div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-bold text-slate-600 mb-1">By Match Status:</div>
                  <div className="bg-slate-100 rounded p-2 text-[10px] font-mono text-slate-700 space-y-0.5">
                    {Object.entries(d.sections.handoff_estimates.breakdown_by_match).map(([match, count]) => (
                      <div key={match} className={
                        match === 'matched' ? 'text-emerald-600' :
                        match === 'unmatched' ? 'text-red-600' :
                        'text-amber-600'
                      }>{match}: {count}</div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>
          )}

          {/* QB Sync Logs */}
          {d.sections?.qb_sync_logs && (
            <Section 
              title="QB Sync Logs (Handoff-related)" 
              icon={<AlertCircle className="w-3.5 h-3.5" />}
              expanded={expandedSections.qb_logs}
              onToggle={() => toggleSection('qb_logs')}
            >
              <div className="space-y-2">
                <Stat label="Webhook-triggered QB logs" value={d.sections.qb_sync_logs.total_webhook_logs} />
                <Stat label="Handoff-related logs" value={d.sections.qb_sync_logs.handoff_related} color="text-orange" />

                {d.sections.qb_sync_logs.recent_errors.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-bold text-red-700 mb-1">❌ Recent QB Errors:</div>
                    <div className="space-y-1">
                      {d.sections.qb_sync_logs.recent_errors.slice(0, 3).map((err, i) => (
                        <div key={i} className="bg-red-100 border border-red-200 rounded p-2 text-[9px]">
                          <div className="font-bold text-red-800">{err.entity_name} ({err.qb_type})</div>
                          <div className="text-red-700 mt-0.5 break-words">{err.error}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Integration Sync Logs */}
          {d.sections?.integration_sync && (
            <Section 
              title="Integration Sync History" 
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              expanded={expandedSections.sync_history}
              onToggle={() => toggleSection('sync_history')}
            >
              <div className="space-y-2">
                <Stat label="Total Handoff syncs" value={d.sections.integration_sync.total_syncs} />
                
                {d.sections.integration_sync.recent.length > 0 && (
                  <div className="space-y-1">
                    {d.sections.integration_sync.recent.slice(0, 3).map((sync, i) => (
                      <div key={i} className="bg-slate-100 rounded p-2 text-[9px]">
                        <div className="font-bold flex items-center gap-1">
                          <span className={
                            sync.status === 'success' ? 'text-emerald-600' :
                            sync.status === 'failed' ? 'text-red-600' :
                            'text-amber-600'
                          }>{sync.status}</span>
                        </div>
                        <div className="text-slate-600 mt-0.5">
                          Created: {sync.created_count} · Updated: {sync.updated_count} · Skipped: {sync.skipped_count}
                        </div>
                        {sync.error_message && <div className="text-red-600 mt-0.5">❌ {sync.error_message}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Webhook Configuration */}
          <div className="bg-blue-50 border border-blue-200 rounded p-2.5">
            <div className="text-[10px] font-bold text-blue-800 mb-1">📡 Webhook Setup</div>
            <div className="text-[9px] text-blue-700 space-y-1">
              <div>Endpoint: <span className="font-mono text-blue-600 break-all">/functions/handoffWebhookV2</span></div>
              <div>Status: Auto-configured</div>
              <div>Auto-sync: Every 15 minutes via handoffAutoSync</div>
            </div>
          </div>

          {/* Timestamp */}
          <div className="text-[9px] text-slate-500 text-center pt-2">
            Generated: {new Date(d.timestamp).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Helper Components ── */

function Section({ title, icon, expanded, onToggle, children }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2 rounded hover:bg-white/60 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
        <div className="text-slate-400">{icon}</div>
        <span className="text-xs font-bold text-slate-700">{title}</span>
      </button>
      {expanded && <div className="ml-6 space-y-2 mt-1">{children}</div>}
    </div>
  );
}

function Stat({ label, value, color = 'text-slate-800' }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-slate-600">{label}</span>
      <span className={`font-bold ${color}`}>{value}</span>
    </div>
  );
}