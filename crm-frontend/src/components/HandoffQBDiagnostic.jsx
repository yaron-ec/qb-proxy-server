/**
 * HandoffQBDiagnostic — Connection health check for Handoff → QuickBooks
 *
 * Displays:
 * - Handoff connected: yes/no
 * - QuickBooks connected: yes/no
 * - QB company name
 * - Last estimate found
 * - Last Handoff estimate imported
 * - Health status and errors/warnings
 */

import { useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import {
  Loader2, CheckCircle, AlertTriangle, AlertCircle, RefreshCw,
  ChevronDown, ChevronRight, Link, Unlink
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

const fmtTime = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const StatusIcon = ({ status }) => {
  if (status === 'healthy') return <CheckCircle className="w-4 h-4 text-emerald-600" />;
  if (status === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  if (status === 'critical') return <AlertCircle className="w-4 h-4 text-red-600" />;
  return <AlertCircle className="w-4 h-4 text-slate-400" />;
};

export default function HandoffQBDiagnostic() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { toast } = useToast();

  const runDiagnostic = async () => {
    setLoading(true);
    try {
      const res = await railwayRequest('/handoff/qb-connection', {});
      setDiagnostics(res.diagnostics);
      setCollapsed(false);
      
      // Show toast summary
      if (res.diagnostics?.health_status === 'healthy') {
        toast({
          title: '✅ Connection Healthy',
          description: 'Handoff → QuickBooks is working properly',
          variant: 'default',
          dedup_key: 'handoff_qb_diagnostic',
        });
      } else if (res.data.diagnostics.health_status === 'warning') {
        toast({
          title: '⚠️ Warning',
          description: res.data.diagnostics.warnings?.[0] || 'Check details below',
          variant: 'default',
          dedup_key: 'handoff_qb_diagnostic',
        });
      } else if (res.data.diagnostics.health_status === 'critical') {
        toast({
          title: '❌ Critical Issue',
          description: res.data.diagnostics.errors?.[0] || 'Connection check failed',
          variant: 'destructive',
          dedup_key: 'handoff_qb_diagnostic',
        });
      }
    } catch (e) {
      toast({
        title: 'Diagnostic failed',
        description: e.message,
        variant: 'destructive',
        dedup_key: 'handoff_qb_diagnostic',
      });
    } finally {
      setLoading(false);
    }
  };

  const d = diagnostics;
  const healthColor = {
    healthy: 'bg-emerald-50 border-emerald-200',
    warning: 'bg-amber-50 border-amber-200',
    critical: 'bg-red-50 border-red-200',
    unknown: 'bg-slate-50 border-slate-200',
    error: 'bg-red-50 border-red-200',
  };
  const healthTextColor = {
    healthy: 'text-emerald-800',
    warning: 'text-amber-800',
    critical: 'text-red-800',
    unknown: 'text-slate-800',
    error: 'text-red-800',
  };

  return (
    <div className={`border rounded-lg ${d ? healthColor[d.health_status] : 'bg-white border-slate-200'}`}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:opacity-90 transition-opacity"
      >
        <div className="flex items-center gap-3">
          {collapsed ? (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
          <div className="flex items-center gap-2">
            {d && <StatusIcon status={d.health_status} />}
            <span className={`text-sm font-bold ${d ? healthTextColor[d.health_status] : 'text-slate-800'}`}>
              Handoff ↔ QuickBooks Connection
            </span>
            {d && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white/60">
                {d.health_status === 'healthy' && '✓ Healthy'}
                {d.health_status === 'warning' && '⚠️ Warning'}
                {d.health_status === 'critical' && '❌ Critical'}
                {d.health_status === 'unknown' && '?'}
              </span>
            )}
          </div>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            runDiagnostic();
          }}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>Check</span>
        </button>
      </button>

      {!collapsed && d && (
        <div className="px-4 pb-4 space-y-3 border-t border-current border-opacity-10">
          {/* Quick Status Grid */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="flex items-center gap-2 p-2 bg-white/60 rounded">
              <div className={`w-2 h-2 rounded-full ${d.handoff_connected ? 'bg-emerald-500' : 'bg-red-400'}`} />
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Handoff</div>
                <div className="text-xs font-semibold text-slate-800">{d.handoff_connected ? '✓ Connected' : '✗ Disconnected'}</div>
              </div>
            </div>

            <div className="flex items-center gap-2 p-2 bg-white/60 rounded">
              <div className={`w-2 h-2 rounded-full ${d.qb_connected ? 'bg-emerald-500' : 'bg-red-400'}`} />
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">QuickBooks</div>
                <div className="text-xs font-semibold text-slate-800">{d.qb_connected ? '✓ Connected' : '✗ Disconnected'}</div>
              </div>
            </div>
          </div>

          {/* QB Company Info */}
          {d.qb_connected && d.qb_company_name && (
            <div className="p-2 bg-white/60 rounded">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">QB Company</div>
              <div className="text-xs font-semibold text-slate-800">{d.qb_company_name}</div>
              <div className="text-[9px] text-slate-600 font-mono">{d.qb_company_id}</div>
            </div>
          )}

          {/* Last QB Estimate */}
          {d.last_qb_estimate && (
            <div className="p-2 bg-white/60 rounded">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">Last QB Estimate</div>
              <div className="text-xs text-slate-800">
                <div className="font-semibold">{d.last_qb_estimate.title}</div>
                <div className="text-slate-600 mt-0.5">
                  ${(d.last_qb_estimate.total || 0).toLocaleString()} · {d.last_qb_estimate.status} · {fmtTime(d.last_qb_estimate.created_date)}
                </div>
              </div>
            </div>
          )}

          {/* Last Handoff Estimate in Base44 */}
          {d.last_handoff_estimate_in_base44 && (
            <div className="p-2 bg-white/60 rounded">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">Last Handoff Estimate Imported</div>
              <div className="text-xs text-slate-800 space-y-0.5">
                <div>
                  <span className="font-semibold">#{d.last_handoff_estimate_in_base44.estimate_number || d.last_handoff_estimate_in_base44.handoff_estimate_number}</span>
                  <span className="text-slate-600 ml-1">
                    {d.last_handoff_estimate_in_base44.status && `(${d.last_handoff_estimate_in_base44.status})`}
                  </span>
                </div>
                {d.last_handoff_estimate_in_base44.push_indicator && (
                  <div className="text-[9px] text-slate-600">{d.last_handoff_estimate_in_base44.push_indicator}</div>
                )}
                {d.last_handoff_estimate_in_base44.received_at && (
                  <div className="text-[9px] text-slate-600">{fmtTime(d.last_handoff_estimate_in_base44.received_at)}</div>
                )}
                {d.last_handoff_estimate_in_base44.lead_matched && (
                  <div className="text-[9px] text-emerald-700 font-semibold">✓ Lead matched</div>
                )}
                {d.last_handoff_estimate_in_base44.error && (
                  <div className="text-[9px] text-red-700">❌ {d.last_handoff_estimate_in_base44.error}</div>
                )}
              </div>
            </div>
          )}

          {/* Stats */}
          {d.handoff_estimates_in_base44_count > 0 && (
            <div className="p-2 bg-white/60 rounded">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">Stats</div>
              <div className="text-xs text-slate-800">
                <div>Handoff estimates imported: <span className="font-bold text-emerald-700">{d.handoff_estimates_in_base44_count}</span></div>
              </div>
            </div>
          )}

          {/* Errors */}
          {d.errors && d.errors.length > 0 && (
            <div className="p-2 bg-red-100/50 rounded border border-red-200">
              <div className="text-[10px] font-bold uppercase tracking-widest text-red-700 mb-1">❌ Errors</div>
              <div className="space-y-1">
                {d.errors.map((err, i) => (
                  <div key={i} className="text-[10px] text-red-700 break-words">{err}</div>
                ))}
              </div>
            </div>
          )}

          {/* Warnings */}
          {d.warnings && d.warnings.length > 0 && (
            <div className="p-2 bg-amber-100/50 rounded border border-amber-200">
              <div className="text-[10px] font-bold uppercase tracking-widest text-amber-700 mb-1">⚠️ Warnings</div>
              <div className="space-y-1">
                {d.warnings.map((warn, i) => (
                  <div key={i} className="text-[10px] text-amber-700 break-words">{warn}</div>
                ))}
              </div>
            </div>
          )}

          {/* Last checked */}
          <div className="text-[9px] text-slate-500">
            Last checked: {fmtTime(d.timestamp)}
          </div>
        </div>
      )}

      {!collapsed && !d && (
        <div className="px-4 py-3 border-t border-slate-200 text-center">
          <p className="text-xs text-slate-500 mb-3">Click "Check" above to run diagnostic</p>
          <button
            onClick={runDiagnostic}
            disabled={loading}
            className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 text-xs font-bold rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Run Diagnostic
          </button>
        </div>
      )}
    </div>
  );
}