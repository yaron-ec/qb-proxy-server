import { useState } from "react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import { EditableKPIChip, KPIChip } from "@/components/DesignSystem";
import DealPaymentPanel from "@/components/DealPaymentPanel";
import QBStatusPanel from "@/components/QBStatusPanel";
import { AlertTriangle } from "lucide-react";

/**
 * CustomerCollections — "what does the customer still owe, and what have we
 * actually collected." Deliberately separate from job PROFITABILITY (see
 * ProfitabilitySummary/CostBreakdown): QuickBooks stays authoritative for
 * real customer payments, and a rep needs this even when they can't see
 * cost/margin data. Just the compact KPI summary — sits alongside
 * CostBreakdown in FinancialsTab's two-column grid. Payment Schedule and
 * QuickBooks detail live in PaymentScheduleSection below, at full width,
 * since they carry their own operational complexity that a half-width
 * column would cramp.
 */
export default function CustomerCollections({ deal, lead, fin, setDeal, setLead, waterfallError }) {
  const [saving, setSaving] = useState(false);

  const saveProjectTotal = async (v) => {
    setSaving(true);
    try {
      const newTotal = parseFloat(v) || 0;
      const currentPaid = fin.paymentsReceived || 0;
      const updates = {
        amount: newTotal,
        balance_due: Math.max(0, newTotal - currentPaid),
        payment_status: currentPaid === 0 ? "unpaid" : currentPaid >= newTotal ? "paid" : "partial",
      };
      const res = await railwayDeals.update(deal.id, updates);
      setDeal(res?.deal || { ...deal, ...updates });
      if (lead?.id) {
        const leadRes = await railwayLeads.update(lead.id, { estimated_value: newTotal });
        setLead(leadRes?.lead || { ...lead, estimated_value: newTotal });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="typography-section-header mb-2">CUSTOMER COLLECTIONS</p>

      {waterfallError && (
        <div className="px-4 py-3 mb-2 bg-amber-50 border border-amber-300 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-amber-800">Payment waterfall computation failed</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              The Paid amount below may not reflect actual QuickBooks received money. Error: {waterfallError}
            </p>
          </div>
        </div>
      )}

      <div className="card-premium p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <EditableKPIChip label="Project Value" value={fin.totalRevenue} onSave={saveProjectTotal} className={saving ? "opacity-60" : ""} />
          <KPIChip label="Invoiced" value={fin.invoiced} variant="invoiced" />
          <KPIChip label="Paid" value={fin.paymentsReceived} variant="collected" />
          <KPIChip label="Balance (Invoiced − Paid)" value={fin.balance} variant="balance" />
          <KPIChip label="Remaining (Project − Paid)" value={fin.remainingCustomerBalance} variant="remaining" />
        </div>
      </div>
    </div>
  );
}

/**
 * PaymentScheduleSection — Payment Schedule (DealPaymentPanel) + QuickBooks
 * status, full width below the Collections/Cost Breakdown grid. Related to
 * Customer Collections above but distinct operational detail — separate
 * cards, same section-label convention as the rest of the CRM (OverviewTab's
 * CLIENT/PROJECT INFO/NOTES cards), instead of nesting a card inside a card.
 */
export function PaymentScheduleSection({ deal, lead, invoices, saleInvoices, waterfall, setDeal, refreshLead }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="typography-section-header mb-2">PAYMENT SCHEDULE</p>
        <DealPaymentPanel deal={deal} lead={lead} onDealUpdate={setDeal} invoices={invoices} saleInvoices={saleInvoices} waterfall={waterfall} />
      </div>

      {lead?.id && (
        <div>
          <p className="typography-section-header mb-2">QUICKBOOKS</p>
          <div className="card-premium p-4">
            <QBStatusPanel lead={{ ...lead, status: "Sold" }} onLeadUpdated={refreshLead} />
          </div>
        </div>
      )}
    </div>
  );
}
