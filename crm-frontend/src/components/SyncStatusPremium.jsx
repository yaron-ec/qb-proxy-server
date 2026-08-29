/**
 * SyncStatusPremium — Premium sync indicator with smooth animations
 */

import { useState, useEffect } from "react";
import { useSync } from "@/lib/syncContext";
import { Zap, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

export default function SyncStatusPremium() {
  const { activeJobs = [], completedJobs = [] } = useSync() || {};
  const [expanded, setExpanded] = useState(false);

  const hasSyncRunning = (activeJobs || []).length > 0;

  if (!hasSyncRunning && (completedJobs || []).length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm">
      {/* Floating Sync Badge */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full card-premium p-4 transition-all duration-200 ${
          expanded ? 'shadow-xl' : 'shadow-lg hover:shadow-xl'
        } ${hasSyncRunning ? 'bg-blue-50 border border-blue-100' : 'bg-emerald-50 border border-emerald-100'}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {hasSyncRunning ? (
              <>
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                <div>
                  <p className="text-sm font-semibold text-slate-900">Syncing...</p>
                  <p className="text-xs text-slate-600">{(activeJobs || []).length} job{(activeJobs || []).length > 1 ? 's' : ''}</p>
                </div>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-900">All synced</p>
                  <p className="text-xs text-slate-600">Last: just now</p>
                </div>
              </>
            )}
          </div>
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </button>

      {/* Expanded Details */}
      {expanded && (
        <div className="absolute bottom-20 right-0 w-full card-premium shadow-xl overflow-hidden animate-slide-up">
          <div className="bg-slate-50 border-b border-slate-100 p-3">
            <h4 className="font-semibold text-xs text-slate-700 uppercase tracking-wider">Sync Status</h4>
          </div>

          <div className="p-4 space-y-3 max-h-64 overflow-y-auto">
            {/* Active Jobs */}
            {(activeJobs || []).map(job => (
              <div key={job.id} className="flex items-start gap-3 pb-3 border-b border-slate-100 last:border-b-0 last:pb-0">
                <Zap className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5 animate-sync" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900">{job.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">Running for {job.duration || '<1m'}</p>
                </div>
              </div>
            ))}

            {/* Completed Jobs */}
            {(completedJobs || []).slice(0, 3).map(job => (
              <div key={job.id} className="flex items-start gap-3 pb-3 border-b border-slate-100 last:border-b-0 last:pb-0">
                {job.error ? (
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900">{job.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{job.error ? `Error: ${job.error}` : 'Completed'}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-slate-50 border-t border-slate-100 px-4 py-2">
            <button className="text-xs text-blue-600 hover:text-blue-700 font-semibold">
              View All Syncs →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}