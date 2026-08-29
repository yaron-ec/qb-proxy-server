/**
 * Unified Timeline Component
 * For activity feeds, call logs, action histories
 */

export function TimelineEntry({ icon: Icon, label, timestamp, children, metadata = null }) {
  return (
    <div className="flex gap-3 py-3 px-1">
      {/* Timeline dot */}
      <div className="flex flex-col items-center pt-1.5 flex-shrink-0">
        <div className="w-2 h-2 rounded-full bg-slate-400" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-3 border-b border-slate-100 group-last:border-0">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className="text-[11px] font-semibold text-slate-700">{label}</span>
          <span className="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0">{timestamp}</span>
        </div>
        {children && <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{children}</p>}
        {metadata && <p className="text-[10px] text-slate-400 mt-1">{metadata}</p>}
      </div>
    </div>
  );
}

export function TimelineContainer({ children }) {
  return <div className="space-y-px">{children}</div>;
}