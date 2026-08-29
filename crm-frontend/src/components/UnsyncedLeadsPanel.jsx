import { useState, useCallback, useEffect, useRef } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { startSync } from "@/lib/syncStore";
import {
  AlertCircle, RefreshCw, ChevronDown, ChevronRight,
  Loader2, ExternalLink, Zap, Info, Search, X, Filter
} from "lucide-react";

// ── Reason config ─────────────────────────────────────────────────
const REASONS = {
  'Not yet synced to CRM':       { color: 'bg-blue-50 text-blue-700 border-blue-200',    label: 'Not synced' },
  'Missing email':               { color: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Missing email' },
  'Missing email and phone':     { color: 'bg-red-50 text-red-700 border-red-200',       label: 'No contact info' },
  'Invalid phone':               { color: 'bg-orange-50 text-orange-700 border-orange-200', label: 'Invalid phone' },
  'Missing name':                { color: 'bg-slate-100 text-slate-500 border-slate-200', label: 'Missing name' },
  'Duplicate — matched by email':{ color: 'bg-purple-50 text-purple-700 border-purple-200', label: 'Duplicate' },
  'Archived contact':            { color: 'bg-slate-100 text-slate-400 border-slate-200', label: 'Archived' },
  'Sync failure':                { color: 'bg-red-50 text-red-700 border-red-200',        label: 'Sync failure' },
  'Owner mapping failed':        { color: 'bg-yellow-50 text-yellow-700 border-yellow-200', label: 'Owner issue' },
  'Placeholder email':           { color: 'bg-slate-100 text-slate-400 border-slate-200', label: 'Placeholder email' },
};

// Reasons that are retryable (quick sync may resolve them)
const RETRYABLE_REASONS = new Set([
  'Not yet synced to CRM',
  'Sync failure',
  'Owner mapping failed',
  'Missing email',
]);

function reasonCfg(reason) {
  return REASONS[reason] || { color: 'bg-slate-100 text-slate-500 border-slate-200', label: reason };
}

// All unique filter options
const ALL_FILTER = 'All reasons';

export default function UnsyncedLeadsPanel() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [search, setSearch] = useState('');
  const [filterReason, setFilterReason] = useState(ALL_FILTER);
  const prevSyncingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await railwayRequest('/leads/unsynced', {});
      setData(res);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !data && !loading) load();
  };

  // Auto-refresh after sync completes — poll syncStore state
  useEffect(() => {
    const interval = setInterval(() => {
      // Detect sync completion by checking if window.__syncCompleted flag is set
      // We subscribe via a simple DOM event instead of importing syncStore
      const el = document.getElementById('__sync_done_signal');
      if (el && el.dataset.done === '1' && expanded && data) {
        el.dataset.done = '0';
        load();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [expanded, data, load]);

  const handleRetry = async () => {
    setRetrying(true);
    startSync('quick');
    setTimeout(() => setRetrying(false), 2000);
  };

  // Derived data
  const allReasons = data?.unsynced
    ? [ALL_FILTER, ...Array.from(new Set(data.unsynced.map(r => r.reason)))]
    : [ALL_FILTER];

  const grouped = data?.unsynced
    ? Object.entries(
        data.unsynced.reduce((acc, r) => {
          acc[r.reason] = (acc[r.reason] || 0) + 1;
          return acc;
        }, {})
      ).sort((a, b) => b[1] - a[1])
    : [];

  const displayList = (data?.unsynced || []).filter(r => {
    const matchReason = filterReason === ALL_FILTER || r.reason === filterReason;
    const q = search.trim().toLowerCase();
    const matchSearch = !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.hubspot_id.includes(q);
    return matchReason && matchSearch;
  });

  const retryableCount = (data?.unsynced || []).filter(r => RETRYABLE_REASONS.has(r.reason)).length;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* ── Header ────────────────────────────────────────────────── */}
      <button
        onClick={handleExpand}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-500" />
          <span className="text-sm font-semibold text-slate-700">Unmatched HubSpot Contacts</span>
          {data && (
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
              data.unsynced_count > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
            }`}>
              {data.unsynced_count} unmatched
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <button
              onClick={e => { e.stopPropagation(); load(); }}
              className="text-xs text-slate-400 hover:text-slate-600 font-semibold flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          )}
          {expanded
            ? <ChevronDown className="w-4 h-4 text-slate-400" />
            : <ChevronRight className="w-4 h-4 text-slate-400" />
          }
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100">
          {/* Loading */}
          {loading && (
            <div className="flex items-center gap-2 px-5 py-6 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Comparing all HubSpot contacts against CRM leads…
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="px-5 py-4 bg-red-50 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
              <button onClick={load} className="ml-auto text-xs font-semibold hover:underline">Retry</button>
            </div>
          )}

          {data && !loading && (
            <div className="p-5 space-y-4">

              {/* ── Summary cards ─────────────────────────────── */}
              <div className="grid grid-cols-3 gap-3">
                <SummaryCard label="HubSpot contacts" value={data.total_hs_contacts} color="blue" />
                <SummaryCard label="Matched in CRM" value={data.synced_count} color="emerald" />
                <SummaryCard label="Unmatched" value={data.unsynced_count} color={data.unsynced_count > 0 ? "amber" : "emerald"} />
              </div>

              {/* ── Match logic note ──────────────────────────── */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex items-start gap-2 text-xs text-slate-600">
                <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                <span>Matched by: HubSpot contact ID → normalized email → last-10-digit phone. A contact matched by any method is considered synced.</span>
              </div>

              {/* ── All matched ───────────────────────────────── */}
              {data.unsynced_count === 0 && (
                <div className="text-center py-6 text-sm text-emerald-700 font-semibold">
                  ✅ All HubSpot contacts are matched in the CRM.
                </div>
              )}

              {data.unsynced_count > 0 && (
                <>
                  {/* ── Reason breakdown badges ───────────────── */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-500">Breakdown by reason</p>
                    <div className="flex flex-wrap gap-2">
                      {grouped.map(([reason, count]) => {
                        const cfg = reasonCfg(reason);
                        const active = filterReason === reason;
                        return (
                          <button
                            key={reason}
                            onClick={() => setFilterReason(active ? ALL_FILTER : reason)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${cfg.color} ${active ? 'ring-2 ring-offset-1 ring-slate-400' : 'hover:opacity-80'}`}
                          >
                            <span>{cfg.label}</span>
                            <span className="font-black">{count}</span>
                            {active && <X className="w-3 h-3" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── Actions row ───────────────────────────── */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={handleRetry}
                      disabled={retrying || retryableCount === 0}
                      className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 text-xs font-bold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
                    >
                      {retrying
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Zap className="w-3.5 h-3.5" />
                      }
                      Retry Sync ({retryableCount} retryable)
                    </button>
                    <span className="text-xs text-slate-400">
                      Triggers a quick sync — only fetches contacts modified since last sync
                    </span>
                  </div>

                  {/* ── Search + filter bar ───────────────────── */}
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search by name, email, or HubSpot ID…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full border border-slate-200 rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:border-amber-500 transition-colors"
                      />
                      {search && (
                        <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {filterReason !== ALL_FILTER && (
                      <button
                        onClick={() => setFilterReason(ALL_FILTER)}
                        className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 text-xs font-semibold rounded-lg hover:bg-slate-50"
                      >
                        <Filter className="w-3 h-3" /> Clear filter
                      </button>
                    )}
                  </div>

                  {/* ── Table ─────────────────────────────────── */}
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[1fr_1.3fr_0.9fr_1.5fr] bg-slate-50 border-b border-slate-200 px-4 py-2.5">
                      <span className="text-[11px] font-semibold text-slate-400">Name</span>
                      <span className="text-[11px] font-semibold text-slate-400">Email</span>
                      <span className="text-[11px] font-semibold text-slate-400">Phone</span>
                      <span className="text-[11px] font-semibold text-slate-400">Reason</span>
                    </div>

                    <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
                      {displayList.length === 0 ? (
                        <div className="px-4 py-6 text-center text-sm text-slate-400">No results</div>
                      ) : displayList.map(record => {
                        const cfg = reasonCfg(record.reason);
                        return (
                          <div
                            key={record.hubspot_id}
                            className="grid grid-cols-[1fr_1.3fr_0.9fr_1.5fr] px-4 py-2.5 hover:bg-slate-50 transition-colors items-center"
                          >
                            <div className="min-w-0 pr-2">
                              <div className="text-xs font-semibold text-slate-800 truncate">{record.name}</div>
                              <div className="text-[10px] text-slate-400 font-mono">ID: {record.hubspot_id}</div>
                            </div>
                            <div className="text-xs text-slate-600 truncate pr-2">{record.email || '—'}</div>
                            <div className="text-xs text-slate-600 truncate pr-2">{record.phone || '—'}</div>
                            <div className="flex items-center gap-1.5">
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${cfg.color}`}>
                                {cfg.label}
                              </span>
                              <a
                                href={`https://app.hubspot.com/contacts/${record.hubspot_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-slate-300 hover:text-blue-500 transition-colors flex-shrink-0"
                                title="Open in HubSpot"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 text-[10px] text-slate-400 text-right">
                      Showing {displayList.length} of {data.unsynced_count} unmatched
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  const colors = {
    blue:    'bg-blue-50 border-blue-100 text-blue-700',
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-700',
    amber:   'bg-amber-50 border-amber-100 text-amber-700',
  };
  return (
    <div className={`rounded-lg border p-3 text-center ${colors[color]}`}>
      <div className="text-2xl font-black">{value ?? '—'}</div>
      <div className="text-[11px] font-semibold mt-0.5">{label}</div>
    </div>
  );
}