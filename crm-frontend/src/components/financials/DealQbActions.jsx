import { useState } from "react";
import { qb as railwayQb } from "@/api/railway";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { FileText, Receipt, Loader2 } from "lucide-react";

/**
 * DealQbActions — "Create QB Estimate" / "Create QB Invoice" for a Deal
 * (CRM STABILITY PHASE, completion pass, Section B). Admin/manager only —
 * matches the backend's requireRole('admin','manager') gate.
 *
 * Both actions are idempotent server-side: a second click after success
 * returns the SAME existing estimate/invoice rather than creating a
 * duplicate QuickBooks transaction (lib/qbEstimateInvoice.js).
 *
 * A 422 qb_item_not_configured means no admin has set the default
 * QuickBooks Item yet (Settings -> QuickBooks) — shown verbatim since it
 * already names the exact next step.
 */
export default function DealQbActions({ deal, onSynced }) {
  const { user } = useAuth();
  const isAdminManager = user?.role === "admin" || user?.role === "manager";
  const { toast } = useToast();
  const [creatingEstimate, setCreatingEstimate] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  if (!isAdminManager || !deal?.id) return null;

  const handle = async (kind) => {
    const isEstimate = kind === "estimate";
    (isEstimate ? setCreatingEstimate : setCreatingInvoice)(true);
    try {
      const result = isEstimate ? await railwayQb.createEstimate(deal.id) : await railwayQb.createInvoice(deal.id);
      const label = isEstimate ? "Estimate" : "Invoice";
      const docNumber = isEstimate ? result.qb_estimate_number : result.qb_doc_number;
      toast({
        title: result.created ? `QuickBooks ${label} created` : `QuickBooks ${label} already exists`,
        description: docNumber ? `#${docNumber}` : undefined,
        duration: 4000,
      });
      onSynced?.();
    } catch (e) {
      toast({
        title: `Failed to create QuickBooks ${isEstimate ? "Estimate" : "Invoice"}`,
        description: e.data?.message || e.message,
        variant: "destructive",
        duration: 7000,
      });
    } finally {
      (isEstimate ? setCreatingEstimate : setCreatingInvoice)(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => handle("estimate")}
        disabled={creatingEstimate || !!deal.qb_estimate_id}
        title={deal.qb_estimate_id ? `Already created (#${deal.qb_estimate_number || deal.qb_estimate_id})` : ""}
        className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
      >
        {creatingEstimate ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
        {deal.qb_estimate_id ? "QB Estimate Created" : "Create QB Estimate"}
      </button>
      <button
        onClick={() => handle("invoice")}
        disabled={creatingInvoice}
        className="flex items-center gap-1.5 text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
      >
        {creatingInvoice ? <Loader2 className="w-3 h-3 animate-spin" /> : <Receipt className="w-3 h-3" />}
        Create QB Invoice
      </button>
    </div>
  );
}
