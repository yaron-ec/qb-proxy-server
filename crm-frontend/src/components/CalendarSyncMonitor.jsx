import { useState, useEffect } from "react";
import * as railwayLeads from "@/api/railway/leads";
import { railwayRequest } from "@/lib/railwayClient";
import { RefreshCw, CheckCircle, Clock, AlertCircle, Calendar } from "lucide-react";

export default function CalendarSyncMonitor() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const loadStats = async () => {
    try {
      setLoading(true);
      // Fetch leads with meeting type and upcoming dates only
      const today = new Date().toISOString().slice(0, 10);
      const res = await railwayLeads.list({ limit: 2000 });
      const leads = (res.items || []).filter(l => l.follow_up_type === 'Meeting');

      const futureLeads = leads.filter(l => {
        const d = l.follow_up_date || l.appointment_date;
        return d && d >= today;
      });

      const pending = futureLeads.filter(l => l.google_calendar_sync_status === 'pending');
      const synced = futureLeads.filter(l => l.google_calendar_sync_status === 'synced');
      const errored = futureLeads.filter(l => l.google_calendar_sync_status === 'error');
      const noStatus = futureLeads.filter(l => !l.google_calendar_sync_status);

      setStats({
        total: futureLeads.length,
        pending: pending.length,
        synced: synced.length,
        error: errored.length,
        noStatus: noStatus.length,
        pendingLeads: pending.slice(0, 5).map(l => ({
          id: l.id,
          name: `${l.first_name} ${l.last_name}`,
          date: l.follow_up_date || l.appointment_date,
          error: l.google_calendar_sync_error,
        })),
      });
      setLastRefreshed(new Date());
    } catch (e) {
      console.error('[CalendarSyncMonitor] Error loading stats:', e);
    } finally {
      setLoading(false);
    }
  };

  const triggerRetry = async () => {
    setRetrying(true);
    try {
      const data = await railwayRequest('/calendar/retry-pending', {});
      console.log('[CalendarSyncMonitor] Retry result:', data);
      await loadStats();
    } catch (e) {
      console.error('[CalendarSyncMonitor] Retry error:', e);
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    loadStats();
    // Auto-refresh every 2 minutes
    const interval = setInterval(loadStats, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !stats) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-3">
        <div className="w-4 h-4 border-2 border-slate-300 border-t-amber-500 rounded-full animate-spin" />
        Loading calendar sync status…
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-amber-600" />
          <h3 className="text-sm font-bold text-slate-800">Google Calendar Sync</h3>
        </div>
        <div className="flex items-center gap-2">
          {lastRefreshed && (
            <span className="text-xs text-slate-400">
              {lastRefreshed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={loadStats}
            disabled={loading}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {stats && (
        <>
          {/* Stat counters */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-center">
              <CheckCircle className="w-4 h-4 text-emerald-600 mx-auto mb-1" />
              <div className="text-xl font-bold text-emerald-700">{stats.synced}</div>
              <div className="text-xs text-emerald-600 font-medium">Synced</div>
            </div>
            <div className={`rounded-lg p-3 text-center border ${stats.pending > 0 ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
              <Clock className={`w-4 h-4 mx-auto mb-1 ${stats.pending > 0 ? 'text-amber-600' : 'text-slate-400'}`} />
              <div className={`text-xl font-bold ${stats.pending > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{stats.pending}</div>
              <div className={`text-xs font-medium ${stats.pending > 0 ? 'text-amber-600' : 'text-slate-500'}`}>Pending</div>
            </div>
            <div className={`rounded-lg p-3 text-center border ${stats.error > 0 ? 'bg-red-50 border-red-300' : 'bg-slate-50 border-slate-200'}`}>
              <AlertCircle className={`w-4 h-4 mx-auto mb-1 ${stats.error > 0 ? 'text-red-600' : 'text-slate-400'}`} />
              <div className={`text-xl font-bold ${stats.error > 0 ? 'text-red-700' : 'text-slate-500'}`}>{stats.error}</div>
              <div className={`text-xs font-medium ${stats.error > 0 ? 'text-red-600' : 'text-slate-500'}`}>Failed</div>
            </div>
          </div>

          {/* All good message */}
          {stats.pending === 0 && stats.error === 0 && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              All {stats.synced} future meetings are synced to Google Calendar.
            </div>
          )}

          {/* Pending list */}
          {stats.pending > 0 && (
            <div className="mb-3">
              <div className="text-xs font-semibold text-amber-700 mb-2">
                ⏳ Pending sync — auto-retry runs every 5 minutes
              </div>
              {stats.pendingLeads.map(l => (
                <div key={l.id} className="flex items-center justify-between text-xs bg-amber-50 border border-amber-200 rounded px-3 py-1.5 mb-1">
                  <span className="font-medium text-slate-700">{l.name}</span>
                  <span className="text-slate-500">{l.date}</span>
                </div>
              ))}
              {stats.pending > 5 && (
                <div className="text-xs text-amber-600 mt-1">+ {stats.pending - 5} more pending</div>
              )}
            </div>
          )}

          {/* Manual retry button */}
          {(stats.pending > 0 || stats.error > 0) && (
            <button
              onClick={triggerRetry}
              disabled={retrying}
              className="w-full flex items-center justify-center gap-2 text-xs font-semibold py-2 px-3 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
              {retrying ? 'Retrying…' : 'Retry Now'}
            </button>
          )}

          <div className="mt-3 text-xs text-slate-400 text-center">
            Auto-retry: every 5 min · Reminders send independently (always on)
          </div>
        </>
      )}
    </div>
  );
}