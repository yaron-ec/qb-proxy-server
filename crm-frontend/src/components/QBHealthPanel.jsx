import { useState, useEffect } from 'react';
import { railwayRequest } from '@/lib/railwayClient';
import { CheckCircle, AlertTriangle, Clock, RefreshCw } from 'lucide-react';

export default function QBHealthPanel() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    checkHealth();
  }, []);

  const checkHealth = async () => {
    setLoading(true);
    try {
      const res = await railwayRequest('/qb/health', {});
      setHealth(res);
      // Auto-expand if errors detected
      if (res?.errors?.length > 0 || !res?.connected) {
        setIsExpanded(true);
      }
    } catch (e) {
      setHealth({
        connected: false,
        errors: [e.message],
        recommendations: ['Check your connection and try again'],
      });
      setIsExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded border border-slate-200 p-4 flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin text-slate-400" />
        <span className="text-sm text-slate-500">Checking QuickBooks health...</span>
      </div>
    );
  }

  if (!health) return null;

  const statusColor = health.connected ? 'emerald' : health.errors?.length ? 'red' : 'amber';
  const statusBg = { emerald: 'bg-emerald-50', red: 'bg-red-50', amber: 'bg-amber-50' }[statusColor];
  const statusBorder = { emerald: 'border-emerald-200', red: 'border-red-200', amber: 'border-amber-200' }[statusColor];
  const statusText = { emerald: 'text-emerald-800', red: 'text-red-800', amber: 'text-amber-800' }[statusColor];
  const statusIcon = { emerald: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600' }[statusColor];
  const StatusIcon = health.connected ? CheckCircle : AlertTriangle;

  return (
    <div className={`rounded border p-4 ${statusBg} ${statusBorder}`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-start justify-between text-left hover:opacity-80 transition-opacity"
      >
        <div className="flex items-start gap-3 flex-1">
          <StatusIcon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${statusIcon}`} />
          <div>
            <div className={`font-bold text-sm ${statusText}`}>
              {health.connected ? 'QuickBooks Connected' : 'QuickBooks Issues Detected'}
            </div>
            {health.company_info && (
              <div className={`text-xs ${statusText} mt-1`}>
                {health.company_info.name} · {health.environment}
              </div>
            )}
            {health.errors.length > 0 && (
              <div className={`text-xs ${statusText} mt-1 font-semibold`}>
                {health.errors[0]}
              </div>
            )}
          </div>
        </div>
        <span className={`text-slate-400 text-sm transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {isExpanded && (
        <div className="mt-3 space-y-2 pt-3 border-t border-slate-200/50">

          {/* Last Sync */}
          {health.last_successful_sync && (
            <div className="text-xs text-slate-600 bg-white/40 rounded px-3 py-2">
              <div className="font-semibold flex items-center gap-1">
                <Clock className="w-3 h-3" /> Last Successful Sync
              </div>
              <div className="mt-1">{new Date(health.last_successful_sync).toLocaleString()}</div>
            </div>
          )}

          {/* Errors */}
          {health.errors?.length > 0 && (
            <div className="bg-red-100/50 rounded px-3 py-2">
              {health.errors.map((err, i) => (
                <div key={i} className="text-xs text-red-700">✗ {err}</div>
              ))}
            </div>
          )}

          {/* Refresh Button */}
          <button
            onClick={checkHealth}
            className="w-full mt-3 flex items-center justify-center gap-1.5 text-xs font-bold py-2 bg-slate-100 rounded hover:bg-slate-200 transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Re-check Health
          </button>
        </div>
      )}
    </div>
  );
}