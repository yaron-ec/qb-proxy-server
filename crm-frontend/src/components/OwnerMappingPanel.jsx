import { useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { UserCog, ChevronDown, ChevronRight, Loader2, CheckCircle, AlertTriangle } from "lucide-react";

export default function OwnerMappingPanel() {
  const [open, setOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null); // { owners: { id: { name, email } } }
  const [ownerMap, setOwnerMap] = useState({}); // { id: "Name" }
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [error, setError] = useState(null);

  const handleProbe = async () => {
    setProbing(true);
    setError(null);
    setSaveResult(null);
    try {
      const data = await railwayRequest('/owners/backfill', { probe: true });
      if (data.error) throw new Error(data.error);
      setProbeResult(data);
      // Pre-fill ownerMap with empty strings
      const map = {};
      for (const id of Object.keys(data.owner_ids || {})) {
        map[id] = '';
      }
      setOwnerMap(map);
    } catch (e) {
      setError(e.message);
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveResult(null);
    try {
      const data = await railwayRequest('/owners/backfill', { ownerMap });
      if (data.error) throw new Error(data.error);
      setSaveResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const ownerIds = probeResult ? Object.keys(probeResult.owner_ids || {}) : [];

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <UserCog className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-bold text-slate-700">Owner Mapping</span>
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Fix assigned reps</span>
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 py-4 space-y-4">
          <p className="text-xs text-slate-500">
            Use this tool to map HubSpot owner IDs to rep names and update all leads at once.
            Step 1: Load owners from HubSpot. Step 2: Confirm or edit names. Step 3: Apply.
          </p>

          {!probeResult && (
            <button
              onClick={handleProbe}
              disabled={probing}
              className="flex items-center gap-2 bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg hover:bg-slate-900 disabled:opacity-50 transition-colors"
            >
              {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCog className="w-3.5 h-3.5" />}
              {probing ? 'Loading owners...' : 'Load HubSpot Owners'}
            </button>
          )}

          {probeResult && ownerIds.length === 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              No owner IDs found on HubSpot contacts.
            </p>
          )}

          {probeResult && ownerIds.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-slate-600">
                Found {ownerIds.length} unique owner IDs — confirm or edit the names below:
              </p>
              <div className="space-y-2">
                {ownerIds.map(id => {
                  const info = probeResult.owner_ids[id];
                  return (
                    <div key={id} className="flex items-center gap-3">
                      <div className="min-w-0 flex-shrink-0 w-32">
                        <div className="text-xs text-slate-500 font-mono">ID: {id}</div>
                        {info?.samples?.length > 0 && (
                          <div className="text-[10px] text-slate-400 truncate">{info.samples.join(', ')} +{info.count}</div>
                        )}
                      </div>
                      <input
                        type="text"
                        value={ownerMap[id] || ''}
                        onChange={e => setOwnerMap(m => ({ ...m, [id]: e.target.value }))}
                        placeholder="Rep name..."
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-amber-600 text-white text-xs font-bold px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                  {saving ? 'Applying...' : 'Apply to All Leads'}
                </button>
                <button
                  onClick={() => { setProbeResult(null); setSaveResult(null); setError(null); }}
                  className="text-xs text-slate-500 hover:text-slate-700 font-semibold px-3 py-2"
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {saveResult && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 space-y-1">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                <span className="text-sm font-bold text-emerald-800">Done!</span>
              </div>
              <div className="text-xs text-emerald-700 flex gap-4">
                <span>✅ Updated: <strong>{saveResult.updated}</strong></span>
                <span>⏭ Skipped: <strong>{saveResult.skipped}</strong></span>
                {saveResult.failed > 0 && <span>❌ Failed: <strong>{saveResult.failed}</strong></span>}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-xs text-red-700 break-all">{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}