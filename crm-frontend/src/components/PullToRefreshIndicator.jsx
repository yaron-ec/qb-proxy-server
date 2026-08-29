import { RefreshCw } from 'lucide-react';

/**
 * Shows a pull-to-refresh indicator at the top of the page.
 * @param {number} pullDistance - current drag distance in px
 * @param {boolean} refreshing - true while the refresh is in progress
 * @param {number} threshold - distance at which refresh triggers
 */
export default function PullToRefreshIndicator({ pullDistance, refreshing, threshold = 72 }) {
  const progress = Math.min(pullDistance / (threshold * 0.45), 1);
  const triggered = progress >= 1;

  if (!refreshing && pullDistance <= 0) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        height: refreshing ? 48 : Math.max(pullDistance, 0),
        transition: refreshing ? 'height 0.2s ease' : 'none',
      }}
    >
      <div
        className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold shadow-md transition-all ${
          triggered || refreshing
            ? 'bg-amber-600 text-white scale-100 opacity-100'
            : 'bg-white text-slate-600 border border-slate-200 opacity-90'
        }`}
        style={{
          transform: `scale(${0.7 + progress * 0.3})`,
          opacity: Math.min(progress * 2, 1),
        }}
      >
        <RefreshCw
          className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
          style={{ transform: refreshing ? undefined : `rotate(${progress * 360}deg)` }}
        />
        <span>{refreshing ? 'Refreshing…' : triggered ? 'Release to refresh' : 'Pull to refresh'}</span>
      </div>
    </div>
  );
}