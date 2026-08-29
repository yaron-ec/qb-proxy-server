/**
 * PendingNativeMigration — placeholder for Lead Detail sections that are
 * awaiting native Railway implementation (QB, SignNow, Submissions).
 *
 * Shows a clear message that no Base44 calls are made and native implementation
 * is pending. Used by QBStatusPanel, SignNowPanel, and SubmissionHistory.
 */
export default function PendingNativeMigration({ feature, description }) {
  return (
    <div className="p-4 text-center">
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-amber-50 border border-amber-200 mb-2">
        <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-slate-700">{feature} — Pending Native Migration</p>
      <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
        {description || "This section is awaiting native Railway implementation. No Base44 calls are made."}
      </p>
    </div>
  );
}