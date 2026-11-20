/**
 * InvoiceMappingPanel — admin-only review of which deal each QuickBooks
 * invoice on this lead is currently mapped to, with an explicit, audited
 * way to move one to a DIFFERENT deal on the SAME lead.
 *
 * CRM repair item 4/5 (Ali & Mohemmed Lalani): a backfill mapped every one
 * of his real invoices to his original roof deal — including ones that
 * most plausibly belong to his separate bathroom-repair addendum — and
 * nothing in the CRM could correct that. qb_invoice_sale_map.crm_sale_id is
 * the durable ownership boundary and is NEVER reassigned automatically
 * (lib/qbInvoiceSaleMap.js); this panel is the deliberate, human-only,
 * reason-required exception, scoped to this one lead's own deals only —
 * it can never move an invoice to a different customer's project.
 *
 * Only rendered for a lead with 2+ deals (a single-deal lead has nothing
 * ambiguous to reassign) and only for admin/manager.
 */
import { useState, useEffect, useCallback } from "react";
import * as railwayInvoiceMapping from "@/api/railway/qbInvoiceMapping";
import { useToast } from "@/components/ui/use-toast";
import { ArrowRightLeft, Loader2, RefreshCw } from "lucide-react";

export default function InvoiceMappingPanel({ lead, canEdit }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reassigning, setReassigning] = useState(null); // qb_invoice_id currently being reassigned
  const [targetDealId, setTargetDealId] = useState({});
  const [reason, setReason] = useState({});
  const { toast } = useToast();

  const load = useCallback(async () => {
    if (!lead?.id) return;
    setLoading(true);
    try {
      const res = await railwayInvoiceMapping.getByLead(lead.id);
      setData(res);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (!data || !Array.isArray(data.deals) || data.deals.length < 2) return null; // nothing ambiguous to review
  if (!Array.isArray(data.invoices) || data.invoices.length === 0) return null;

  const dealName = (id) => data.deals.find((d) => d.id === id)?.name || id;

  const handleReassign = async (qbInvoiceId) => {
    const crm_sale_id = targetDealId[qbInvoiceId];
    const r = (reason[qbInvoiceId] || "").trim();
    if (!crm_sale_id) { toast({ title: "Select a deal first", variant: "destructive", duration: 3000 }); return; }
    if (!r) { toast({ title: "A reason is required", description: "Explain why this invoice belongs to the other project.", variant: "destructive", duration: 4000 }); return; }
    setReassigning(qbInvoiceId);
    try {
      const res = await railwayInvoiceMapping.reassign(qbInvoiceId, { crm_sale_id, reason: r });
      toast({ title: "Invoice reassigned", description: `Moved from "${res.old_deal_name}" to "${res.new_deal_name}".`, duration: 4000 });
      await load();
    } catch (e) {
      toast({ title: "Reassignment failed", description: e.data?.message || e.message, variant: "destructive", duration: 6000 });
    } finally {
      setReassigning(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <ArrowRightLeft className="w-4 h-4 text-amber-600" />
        <h3 className="text-sm font-bold text-slate-800">Invoice → Project Mapping</h3>
        <button onClick={load} className="ml-auto text-slate-400 hover:text-amber-600"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        This lead has {data.deals.length} projects/addendums. Each invoice below is currently billed against ONE of them —
        if an automatic match looks wrong (e.g. an invoice dated after an addendum was accepted, but still billed to the
        original project), reassign it here. A reason is required and recorded on this lead's activity history.
      </p>
      <div className="space-y-2">
        {data.invoices.map((inv) => (
          <div key={inv.qb_invoice_id} className="border border-slate-100 rounded-lg px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div>
                <span className="font-semibold text-slate-800">{inv.qb_doc_number || inv.qb_invoice_id}</span>
                <span className="text-slate-400 mx-1.5">·</span>
                <span className="text-slate-600">${Number(inv.total_amt || 0).toFixed(2)}</span>
                <span className="text-slate-400 mx-1.5">·</span>
                <span className="text-slate-500">{inv.txn_date ? new Date(inv.txn_date).toLocaleDateString() : "no date"}</span>
              </div>
              <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                currently: {dealName(inv.crm_sale_id)}
              </span>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={targetDealId[inv.qb_invoice_id] || ""}
                  onChange={(e) => setTargetDealId((p) => ({ ...p, [inv.qb_invoice_id]: e.target.value }))}
                  className="text-[11px] border border-slate-200 rounded px-2 py-1 flex-1"
                >
                  <option value="">Move to…</option>
                  {data.deals.filter((d) => d.id !== inv.crm_sale_id).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Reason (required)"
                  value={reason[inv.qb_invoice_id] || ""}
                  onChange={(e) => setReason((p) => ({ ...p, [inv.qb_invoice_id]: e.target.value }))}
                  className="text-[11px] border border-slate-200 rounded px-2 py-1 flex-[2]"
                />
                <button
                  onClick={() => handleReassign(inv.qb_invoice_id)}
                  disabled={reassigning === inv.qb_invoice_id}
                  className="text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded px-2.5 py-1 flex items-center gap-1"
                >
                  {reassigning === inv.qb_invoice_id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Reassign
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
