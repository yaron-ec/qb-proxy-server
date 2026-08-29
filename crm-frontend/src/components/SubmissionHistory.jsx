/**
 * SubmissionHistory — Native Railway submission history for Lead Detail.
 *
 * Lists all form submissions for a lead from the lead_submissions Postgres
 * table. Each submission shows: date, source, form type, message, submission
 * number, and reactivation status.
 *
 * No Base44 calls. Reads from native Railway Postgres.
 */
import { useState, useEffect, useCallback } from "react";
import { leadSubmissions as railwaySubmissions } from "@/api/railway";
import { History, RefreshCw, AlertCircle } from "lucide-react";

export default function SubmissionHistory({ lead }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadSubmissions = useCallback(async () => {
    if (!lead?.id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await railwaySubmissions.list(lead.id);
      setSubmissions(data.items || []);
    } catch (e) {
      setError(e.message || 'Failed to load submissions');
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  useEffect(() => { loadSubmissions(); }, [loadSubmissions]);

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center">
        <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div className="text-center py-4">
        <History className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
        <p className="text-xs text-slate-400">No submission history</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {submissions.map((sub) => (
        <div key={sub.id} className="border border-slate-200 rounded-lg px-3 py-2.5">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                #{sub.submission_number}
              </span>
              {sub.was_reactivation && (
                <span className="text-[10px] font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded-full">
                  Reactivation
                </span>
              )}
              {sub.source && (
                <span className="text-[10px] font-semibold text-slate-600">{sub.source}</span>
              )}
            </div>
            <span className="text-[10px] text-slate-400">
              {sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
            </span>
          </div>

          {sub.form_type && (
            <p className="text-[11px] text-slate-500 mb-0.5">Form: {sub.form_type}</p>
          )}
          {sub.project_type && (
            <p className="text-[11px] text-slate-500 mb-0.5">Project: {sub.project_type}</p>
          )}
          {sub.message && (
            <p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap line-clamp-3">{sub.message}</p>
          )}

          <div className="flex items-center gap-3 mt-1.5">
            {sub.assigned_rep_at_time && (
              <span className="text-[10px] text-slate-400">Rep: {sub.assigned_rep_at_time}</span>
            )}
            {sub.lead_status_at_time && (
              <span className="text-[10px] text-slate-400">Status: {sub.lead_status_at_time}</span>
            )}
            {sub.previous_status && (
              <span className="text-[10px] text-purple-500">Prev: {sub.previous_status}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}