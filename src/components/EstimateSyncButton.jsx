import { useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { syncQBEstimatesForLead, normalizeIntegrationError } from '@/lib/railwayClient';

export default function EstimateSyncButton({ lead }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const data = await syncQBEstimatesForLead(lead.id);
      const ok = data?.success !== false;
      setResult({ success: ok, message: ok ? (data?.message || 'Estimates synced') : (data?.error || data?.message || 'Sync failed') });
    } catch (e) {
      setResult({ success: false, message: normalizeIntegrationError(e) });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="px-5 py-3 border-t border-slate-100">
      <p className="sidebar-section-header mb-2">Estimates</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">Estimate synchronization</span>
        <button onClick={handleSync} disabled={syncing} className="sidebar-action-btn">
          <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      {result && (
        <div className={`flex items-center gap-1.5 mt-1.5 text-[11px] font-medium ${result.success ? 'text-emerald-600' : 'text-red-500'}`}>
          {result.success ? <CheckCircle2 className="w-3 h-3 flex-shrink-0" /> : <AlertTriangle className="w-3 h-3 flex-shrink-0" />}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
}