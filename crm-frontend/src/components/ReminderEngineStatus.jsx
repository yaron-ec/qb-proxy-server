import { useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { RefreshCw, AlertCircle, CheckCircle, Zap, Clock } from "lucide-react";

export default function ReminderEngineStatus() {
  const [loading, setLoading] = useState(false);
  const [lastReport, setLastReport] = useState(null);
  const [error, setError] = useState(null);

  const handleTestNow = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await railwayRequest('/reminders/test', {});
      setLastReport(res);
    } catch (e) {
      setError(e.message || 'Failed to run reminder test');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Reminder Engine Status</h3>
          <p className="text-xs text-slate-500 mt-0.5">Test appointment reminder system</p>
        </div>
        <button
          onClick={handleTestNow}
          disabled={loading}
          className="flex items-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-bold rounded-lg transition-colors"
        >
          <Zap className="w-3.5 h-3.5" />
          {loading ? 'Running...' : 'Run Reminder Check Now'}
        </button>
      </div>

      {/* Warning */}
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex gap-3">
        <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-slate-700">
          Reminder delivery is handled by the Railway reminder service.
        </div>
      </div>

      {/* Last Report */}
      {lastReport && (
        <div className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-4">
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3">Test Run Summary</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <div className="text-2xl font-black text-slate-900">{lastReport.summary.total_leads_checked}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">Leads Checked</div>
              </div>
              <div>
                <div className="text-2xl font-black text-amber-600">{lastReport.summary.meetings_due_now_count}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">Due Now</div>
              </div>
              <div>
                <div className="text-2xl font-black text-blue-600">{lastReport.summary.reminders_to_send_count}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">To Send</div>
              </div>
              <div>
                <div className="text-2xl font-black text-emerald-600">{lastReport.summary.email_tests_logged}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">Tests Logged</div>
              </div>
              <div>
                <div className="text-2xl font-black text-red-600">{lastReport.summary.errors_count}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">Errors</div>
              </div>
            </div>
          </div>

          {/* Meetings Due Now */}
          {lastReport.report.meetings_due_now.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Meetings Due Now ({lastReport.report.meetings_due_now.length})
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {lastReport.report.meetings_due_now.map((m, i) => (
                  <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs">
                    <div className="font-semibold text-amber-900">{m.lead_name}</div>
                    <div className="text-amber-800 mt-0.5">
                      {m.date_formatted || m.date} at {m.time_formatted || m.time}
                    </div>
                    <div className="flex gap-2 mt-1.5 flex-wrap">
                      <span className="inline-block px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-semibold">
                        Window: {m.window}
                      </span>
                      {m.already_sent && (
                        <span className="inline-block px-2 py-0.5 bg-slate-200 text-slate-600 rounded text-[10px] font-semibold">
                          ✓ Already sent
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reminders To Send */}
          {lastReport.report.reminders_to_send.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Reminders Ready to Send ({lastReport.report.reminders_to_send.length})
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {lastReport.report.reminders_to_send.map((r, i) => (
                  <div key={i} className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs">
                    <div className="font-semibold text-blue-900">{r.lead_name}</div>
                    <div className="text-blue-800 mt-0.5">
                      {r.date_formatted} at {r.time_formatted}
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-1.5 text-[10px]">
                      <div>
                        <span className="text-slate-500">Client:</span> {r.client_email || '—'}
                      </div>
                      <div>
                        <span className="text-slate-500">Owner:</span> {r.owner_email || '—'}
                      </div>
                      <div>
                        <span className="font-semibold text-blue-600">Window: {r.window}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Errors */}
          {lastReport.report.errors.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-red-700 uppercase tracking-wide mb-2">⚠️ Errors ({lastReport.report.errors.length})</h4>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {lastReport.report.errors.map((e, i) => (
                  <div key={i} className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[10px] text-red-800">
                    {e.error}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamp */}
          <div className="text-xs text-slate-500 italic">
            Last run: {new Date(lastReport.summary.timestamp).toLocaleString()}
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Empty State */}
      {!lastReport && !error && (
        <div className="text-center py-6 text-slate-400">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-xs">Click "Run Reminder Check Now" to test the reminder engine</p>
        </div>
      )}
    </div>
  );
}