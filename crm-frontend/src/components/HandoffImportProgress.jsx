import { useState, useRef } from "react";
import { apiCall } from "@/api/railway/client";
import { CheckCircle, AlertTriangle, Loader2, Play, Square, ChevronDown, ChevronUp } from "lucide-react";

function ProgressBar({ value, max, color = "blue" }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const colors = {
    blue:    "bg-blue-500",
    green:   "bg-emerald-500",
    amber:   "bg-amber-500",
  };
  return (
    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
      <div
        className={`h-2 rounded-full transition-all duration-300 ${colors[color]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function HandoffImportProgress() {
  const [running, setRunning]     = useState(false);
  const [stopped, setStopped]     = useState(false);
  const [progress, setProgress]   = useState(null);
  const [errors, setErrors]       = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const stopRef = useRef(false);

  const handleStart = async () => {
    setRunning(true);
    setStopped(false);
    stopRef.current = false;
    setErrors([]);

    // Load all pending seed IDs
    let seeds = [];
    try {
      seeds = await apiCall('/api/v1/handoff-estimate-seeds?status=pending&sort=-created_date&limit=5000', { method: 'GET' }).then(r => r.items || []);
    } catch (e) {
      setProgress({ error: 'Failed to load seed IDs: ' + e.message });
      setRunning(false);
      return;
    }

    if (seeds.length === 0) {
      setProgress({ error: 'No pending seed IDs found. Add IDs using the exporter above first.' });
      setRunning(false);
      return;
    }

    const total = seeds.length;
    let processed = 0, imported = 0, failed = 0, skipped = 0;
    setProgress({ total, processed, imported, failed, skipped, running: true });

    for (const seed of seeds) {
      if (stopRef.current) {
        setStopped(true);
        break;
      }

      try {
        const data = await apiCall('/api/v1/handoff/historical-import', {
          method: 'POST',
          body: {
            action: 'import_single_estimate',
            estimateId: seed.estimateId,
            projectId: seed.projectId || null,
            seedRecordId: seed.id,
          },
        }).catch(e => ({ result: 'failed', error: e.message }));
        if (data?.result === 'imported') imported++;
        else if (data?.result === 'skipped') skipped++;
        else if (data?.result === 'failed') {
          failed++;
          setErrors(prev => [...prev, `${seed.estimateId}: ${data.error || 'unknown error'}`]);
        }
      } catch (e) {
        failed++;
        setErrors(prev => [...prev, `${seed.estimateId}: ${e?.response?.data?.error || e.message}`]);
        // Mark seed as failed
        try {
          await apiCall(`/api/v1/handoff-estimate-seeds/${seed.id}`, {
            method: 'PUT',
            body: {
              status: 'failed',
              error: e.message,
            },
          });
        } catch {}
      }

      processed++;
      setProgress({ total, processed, imported, failed, skipped, running: !stopRef.current });
    }

    setRunning(false);
    setProgress(prev => ({ ...prev, running: false, done: true }));
  };

  const handleStop = () => {
    stopRef.current = true;
  };

  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-800">Import Estimates from Seed IDs</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Fetches each estimate individually from Handoff and imports into CRM.
          </p>
        </div>
        <div className="flex gap-2">
          {running ? (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-red-500 hover:bg-red-600 px-4 py-2 rounded-lg transition-colors"
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg disabled:opacity-50 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {progress?.done ? 'Re-run' : 'Start Import'}
            </button>
          )}
        </div>
      </div>

      {progress?.error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-red-700">{progress.error}</p>
        </div>
      )}

      {progress && !progress.error && (
        <div className="space-y-3">
          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-slate-500 font-semibold">
              <span>{running ? 'Importing...' : stopped ? 'Stopped' : progress.done ? 'Complete' : ''}</span>
              <span>{pct}%</span>
            </div>
            <ProgressBar value={progress.processed} max={progress.total} color={progress.done && !stopped ? 'green' : 'blue'} />
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Total',     val: progress.total,     color: 'bg-slate-50 text-slate-700' },
              { label: 'Processed', val: progress.processed, color: 'bg-blue-50 text-blue-700' },
              { label: 'Imported',  val: progress.imported,  color: 'bg-emerald-50 text-emerald-700' },
              { label: 'Failed',    val: progress.failed,    color: progress.failed > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400' },
            ].map(s => (
              <div key={s.label} className={`text-center rounded-lg py-2 ${s.color}`}>
                <div className="text-lg font-black">{s.val ?? 0}</div>
                <div className="text-[9px] font-semibold uppercase tracking-wide">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Running indicator */}
          {running && (
            <div className="flex items-center gap-2 text-xs text-blue-700 font-semibold">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Processing {progress.processed + 1} of {progress.total}...
            </div>
          )}

          {/* Done state */}
          {progress.done && !stopped && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span className="text-xs font-bold text-emerald-800">
                Import complete — {progress.imported} imported, {progress.skipped} skipped, {progress.failed} failed
              </span>
            </div>
          )}

          {stopped && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span className="text-xs font-bold text-amber-800">
                Stopped at {progress.processed}/{progress.total}. Click Start Import to continue remaining.
              </span>
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div>
              <button
                onClick={() => setShowErrors(s => !s)}
                className="flex items-center gap-1 text-[10px] text-red-500 font-semibold hover:underline"
              >
                {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {errors.length} error{errors.length !== 1 ? 's' : ''}
              </button>
              {showErrors && (
                <div className="mt-1 text-[9px] text-red-700 font-mono bg-red-50 border border-red-100 rounded p-2 space-y-0.5 max-h-28 overflow-y-auto">
                  {errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}