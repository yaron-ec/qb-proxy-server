/**
 * Floating sync status bar — shows active/recent sync jobs globally.
 * Always visible, never blocks navigation or UI.
 */
import { useState } from "react";
import { useSync } from "@/lib/syncContext";
import { Loader2, CheckCircle, AlertTriangle, ChevronDown, ChevronUp, X, RefreshCw, Clock } from "lucide-react";

const STATUS_ICON = {
  queued: <Clock className="w-3.5 h-3.5 text-slate-400" />,
  running: <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />,
  retrying: <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin" />,
  completed: <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />,
  failed: <AlertTriangle className="w-3.5 h-3.5 text-red-500" />,
};

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  completed: 'Done',
  failed: 'Failed',
};

const STATUS_COLOR = {
  queued: 'text-slate-500',
  running: 'text-blue-600',
  retrying: 'text-amber-600',
  completed: 'text-emerald-600',
  failed: 'text-red-600',
};

export default function SyncStatusBar() {
  const { jobs, activeJobs, hasActive, clearCompleted } = useSync();
  const [expanded, setExpanded] = useState(false);

  // Only show if there are any jobs
  if (jobs.length === 0) return null;

  const displayJobs = expanded ? jobs.slice().reverse() : activeJobs.slice(0, 3);
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  const completedCount = jobs.filter(j => j.status === 'completed').length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 shadow-xl rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800 text-white hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-2">
          {hasActive
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300" />
            : failedCount > 0
            ? <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            : <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
          }
          <span className="text-xs font-bold">
            {hasActive
              ? `${activeJobs.length} sync${activeJobs.length > 1 ? 's' : ''} running`
              : failedCount > 0
              ? `${failedCount} sync${failedCount > 1 ? 's' : ''} failed`
              : `${completedCount} sync${completedCount > 1 ? 's' : ''} complete`
            }
          </span>
        </div>
        <div className="flex items-center gap-1">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </div>
      </button>

      {/* Job list */}
      {expanded && (
        <div className="max-h-72 overflow-y-auto">
          {displayJobs.map(job => (
            <div key={job.id} className="px-4 py-2.5 border-b border-slate-100 last:border-b-0">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex-shrink-0">{STATUS_ICON[job.status]}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800 truncate">{job.label}</span>
                    <span className={`text-xs font-bold flex-shrink-0 ${STATUS_COLOR[job.status]}`}>
                      {STATUS_LABEL[job.status]}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{job.integration}</div>
                  {job.progress && (
                    <div className="mt-1">
                      <div className="w-full bg-slate-100 rounded-full h-1.5">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">{job.progress}%</div>
                    </div>
                  )}
                  {job.status === 'failed' && job.error && (
                    <div className="text-xs text-red-600 mt-1 font-mono truncate">{job.error}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {jobs.length === 0 && (
            <div className="px-4 py-4 text-xs text-slate-400 text-center">No recent sync activity</div>
          )}
        </div>
      )}

      {/* Footer actions */}
      {expanded && completedCount > 0 && (
        <div className="px-4 py-2 border-t border-slate-100 flex justify-end">
          <button
            onClick={clearCompleted}
            className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Clear completed
          </button>
        </div>
      )}
    </div>
  );
}