import { useState, useEffect } from "react";
import * as railwayDeals from "@/api/railway/deals";
import { X, Loader2, Link2 } from "lucide-react";

/**
 * AddAddendumModal — the header-level, "+ Add Project"-equivalent entry
 * point for linking an existing deal on this lead as an addendum of the
 * current one (admin-only).
 *
 * BACKGROUND (production correction, November 2026): the Convert-to-Addendum
 * action existed (components/financials/AddendumPanel.jsx,
 * POST /api/v1/deals/:id/convert-to-addendum) but was only reachable from
 * inside the Financials tab's collapsed-by-default "Documents & QuickBooks
 * Mapping" accordion section — a label with no mention of "Addendum" at
 * all, which is why it was never found in production. This modal is the
 * SAME API calls AddendumPanel already used (railwayDeals.list +
 * railwayDeals.convertToAddendum), just triggered from a clearly-labeled
 * header button next to "+ Add Project" instead of being buried — no new
 * backend logic, no second implementation of the conversion rules.
 * AddendumPanel itself keeps displaying the resulting contract totals; its
 * own inline convert-form was removed so there is exactly ONE place to
 * start a conversion, never two divergent entry points for the same action.
 */
export default function AddAddendumModal({ deal, lead, onClose, onSuccess }) {
  const [siblings, setSiblings] = useState([]);
  const [loadingSiblings, setLoadingSiblings] = useState(true);
  const [selectedSiblingId, setSelectedSiblingId] = useState("");
  const [reason, setReason] = useState("");
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSiblings() {
      setLoadingSiblings(true);
      try {
        const list = await railwayDeals.list({ leadId: lead.id, limit: 50 });
        if (cancelled) return;
        // Eligible = same lead, not this deal itself, not already an
        // addendum of something else (addendums are one level deep only —
        // matches lib/dealModel.js#canBecomeAddendumOf's own rule).
        setSiblings((list.items || []).filter((d) => d.id !== deal.id && !d.parent_deal_id));
      } catch {
        if (!cancelled) setSiblings([]);
      } finally {
        if (!cancelled) setLoadingSiblings(false);
      }
    }
    loadSiblings();
    return () => { cancelled = true; };
  }, [deal.id, lead?.id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedSiblingId) { setError("Select a deal to link as an addendum."); return; }
    if (!reason.trim()) { setError("A reason is required."); return; }
    setError(null);
    setConverting(true);
    try {
      await railwayDeals.convertToAddendum(selectedSiblingId, { parent_deal_id: deal.id, reason: reason.trim() });
      onSuccess?.();
    } catch (e2) {
      setError(e2.data?.message || e2.message || "Failed to convert deal to an addendum.");
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Link2 className="w-5 h-5 text-amber-600" />
            Add Addendum
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4">
          <p className="text-xs text-slate-500 mb-4">
            Link an existing project on <span className="font-semibold">{lead?.first_name} {lead?.last_name}</span>'s
            account as an addendum of <span className="font-semibold">{deal.name}</span> — e.g. a separately-created
            deal for an approved change order or add-on scope. Original Contract + this addendum's amount will be
            shown together as the Combined Contract Value.
          </p>

          {loadingSiblings ? (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading eligible projects…
            </div>
          ) : siblings.length === 0 ? (
            <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-3">
              No other eligible projects on this customer's account yet. Create the addendum project first with
              "+ Add Project", then use this action to link it.
            </p>
          ) : (
            <>
              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Project to link as an addendum
              </label>
              <select
                value={selectedSiblingId}
                onChange={(e) => setSelectedSiblingId(e.target.value)}
                disabled={converting}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              >
                <option value="">Select a project…</option>
                {siblings.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} (${Number(d.amount || 0).toFixed(2)})</option>
                ))}
              </select>

              <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Reason (required)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={converting}
                rows={2}
                placeholder="e.g. Approved bathroom repair change order"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              />
            </>
          )}

          {error && <p className="text-xs font-semibold text-rose-600 mt-3">{error}</p>}
        </form>

        <div className="border-t border-slate-200 bg-white px-6 py-4 flex gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={converting}
            className="flex-1 px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={converting || siblings.length === 0}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {converting && <Loader2 className="w-4 h-4 animate-spin" />}
            {converting ? "Linking…" : "Link as Addendum"}
          </button>
        </div>
      </div>
    </div>
  );
}
