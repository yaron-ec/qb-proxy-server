/**
 * AddendumPanel — CRM repair item 1 (November 2026): "Customer → Main
 * Project → Addendums." Shows this deal's addendum relationship (if it
 * has one, or has any) and the combined approved contract total — the
 * SAME number confirmed against the real Ali & Mohemmed Lalani case
 * ($33,000.00 original + $7,934.35 accepted addendum = $40,934.35).
 *
 * Admin-only "Convert to Addendum" lets an admin link an existing,
 * disconnected deal on the SAME lead as an addendum of this one — the
 * exact gap found in the Lalani case, where a rep had created a second,
 * unlinked deal for the accepted bathroom-repair estimate because the CRM
 * had no addendum concept at all. Never automatic — requires picking the
 * exact sibling deal and a reason.
 */
import { useState, useEffect, useCallback } from "react";
import * as railwayDeals from "@/api/railway/deals";
import { useToast } from "@/components/ui/use-toast";
import { Link2, Loader2 } from "lucide-react";

export default function AddendumPanel({ deal, lead, isAdmin, onChange }) {
  const [data, setData] = useState(null);
  const [siblings, setSiblings] = useState([]);
  const [selectedSiblingId, setSelectedSiblingId] = useState("");
  const [reason, setReason] = useState("");
  const [converting, setConverting] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const res = await railwayDeals.getAddendums(deal.id);
      setData(res);
    } catch (e) {
      setData(null);
    }
    if (isAdmin && lead?.id && !deal?.parent_deal_id) {
      try {
        const list = await railwayDeals.list({ leadId: lead.id, limit: 50 });
        setSiblings((list.items || []).filter((d) => d.id !== deal.id && !d.parent_deal_id));
      } catch (e) {
        setSiblings([]);
      }
    }
  }, [deal?.id, deal?.parent_deal_id, lead?.id, isAdmin]);

  useEffect(() => { load(); }, [load]);

  if (!data) return null;

  const handleConvert = async () => {
    if (!selectedSiblingId) { toast({ title: "Select a deal first", variant: "destructive", duration: 3000 }); return; }
    if (!reason.trim()) { toast({ title: "A reason is required", variant: "destructive", duration: 3000 }); return; }
    setConverting(true);
    try {
      await railwayDeals.convertToAddendum(selectedSiblingId, { parent_deal_id: deal.id, reason: reason.trim() });
      toast({ title: "Converted to addendum", duration: 3000 });
      setSelectedSiblingId("");
      setReason("");
      await load();
      if (onChange) onChange();
    } catch (e) {
      toast({ title: "Conversion failed", description: e.data?.message || e.message, variant: "destructive", duration: 6000 });
    } finally {
      setConverting(false);
    }
  };

  const hasAddendums = Array.isArray(data.addendums) && data.addendums.length > 0;
  const isAddendum = !!deal.parent_deal_id;

  if (!hasAddendums && !isAddendum && !isAdmin) return null; // nothing to show, no admin action available

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="w-4 h-4 text-amber-600" />
        <h3 className="text-sm font-bold text-slate-800">Parent Project / Addendums</h3>
      </div>

      {isAddendum && (
        <p className="text-xs text-slate-600 mb-2">
          This project is an <span className="font-semibold">addendum</span> of another project on this lead.
        </p>
      )}

      {hasAddendums && (
        <div className="text-xs text-slate-700 space-y-1 mb-3">
          <div className="flex justify-between"><span>Original Contract</span><span className="font-semibold">${data.original_contract_amount.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Approved Addendums ({data.addendums.length})</span><span className="font-semibold">${data.approved_addendums_amount.toFixed(2)}</span></div>
          <div className="flex justify-between border-t border-slate-100 pt-1 text-sm"><span className="font-bold">Total Approved Contract</span><span className="font-bold text-amber-700">${data.total_approved_contract.toFixed(2)}</span></div>
          <ul className="mt-2 space-y-0.5">
            {data.addendums.map((a) => (
              <li key={a.id} className="text-[11px] text-slate-500">• {a.name} — ${Number(a.amount || 0).toFixed(2)}</li>
            ))}
          </ul>
        </div>
      )}

      {isAdmin && !isAddendum && (
        <div className="border-t border-slate-100 pt-3 mt-1">
          <p className="text-[11px] text-slate-500 mb-2">
            Link an existing deal on this lead as an addendum of this project (e.g. a separately-created deal for an approved change order).
          </p>
          {siblings.length === 0 ? (
            <p className="text-[11px] text-slate-400">No other eligible deals on this lead.</p>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={selectedSiblingId}
                onChange={(e) => setSelectedSiblingId(e.target.value)}
                className="text-[11px] border border-slate-200 rounded px-2 py-1 flex-1"
              >
                <option value="">Select a deal…</option>
                {siblings.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} (${Number(d.amount || 0).toFixed(2)})</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Reason (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="text-[11px] border border-slate-200 rounded px-2 py-1 flex-[2]"
              />
              <button
                onClick={handleConvert}
                disabled={converting}
                className="text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded px-2.5 py-1 flex items-center gap-1"
              >
                {converting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Convert
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
