/**
 * FinancialTab — KPI chips, payment panel, QB panel, invoices.
 *
 * All financial values come from the shared getDealPaymentSummary helper —
 * the single source of truth across the entire CRM. Never recalculate here.
 */
import { useState, useEffect } from "react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import { getDealPaymentSummary } from "@/lib/financialCalc";
import { EditableKPIChip, KPIChip } from "@/components/DesignSystem";
import DealPaymentPanel from "@/components/DealPaymentPanel";
import QBStatusPanel from "@/components/QBStatusPanel";

export default function FinancialTab({
  deal, lead, invoices, setDeal, setLead, refreshLead,
  editingField, setEditingField, savedMsg, setSavedMsg,
}) {
  // ── Single source of truth — shared helper used by every financial component ──
  const fin = getDealPaymentSummary(deal, lead, invoices);
  const { projectTotal, invoiced: totalInvoiced, paid: totalPaid, balance: balanceDue, remaining: amountRemaining } = fin;
  const milestonePaid = (deal.deposit_paid || 0) + (deal.progress_payment_paid || 0) + (deal.final_payment_paid || 0);

  // Auto-sync of stale QB data removed during Base44 exit — QB panel offers manual sync.

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
      {/* Saved confirmation */}
      {savedMsg && (
        <div className="px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-700">
          ✓ {savedMsg}
        </div>
      )}

      {/* Financial Summary — compact KPI chips */}
      <div>
        <p className="typography-section-header mb-2">FINANCIAL SUMMARY</p>
        <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2">
          <EditableKPIChip
            label="Project Total"
            value={projectTotal}
            onSave={async (v) => {
              const newTotal = parseFloat(v) || 0;
              const currentPaid = deal.total_paid || milestonePaid || 0;
              const updates = {
                amount: newTotal,
                balance_due: Math.max(0, newTotal - currentPaid),
                payment_status: currentPaid === 0 ? "unpaid" : currentPaid >= newTotal ? "paid" : "partial",
              };
              await railwayDeals.update(deal.id, updates);
              setDeal(prev => ({ ...prev, ...updates }));
              if (lead?.id) {
                await railwayLeads.update(lead.id, { estimated_value: newTotal });
                setLead(prev => ({ ...prev, estimated_value: newTotal }));
              }
              setSavedMsg("Project Total saved");
              setTimeout(() => setSavedMsg(null), 2000);
            }}
          />
          <KPIChip label="Invoiced" value={totalInvoiced} variant="invoiced" />
          <KPIChip label="Paid" value={totalPaid} variant="collected" />
          <KPIChip label="Balance" value={balanceDue} variant="balance" />
          <KPIChip label="Remaining" value={amountRemaining} variant="remaining" />
        </div>
      </div>

      {/* Payment Schedule */}
      <div>
        <p className="typography-section-header mb-2">PAYMENT SCHEDULE</p>
        <DealPaymentPanel deal={deal} lead={lead} onDealUpdate={setDeal} invoices={invoices} />
      </div>

      {/* QuickBooks — only render if a lead is linked (lead.id is the Railway UUID) */}
      {lead?.id && (
        <div>
          <p className="typography-section-header mb-2">QUICKBOOKS</p>
          <div className="card-premium overflow-hidden">
            <QBStatusPanel lead={{ ...lead, status: "Sold" }} onLeadUpdated={refreshLead} />
          </div>
        </div>
      )}


    </div>
  );
}