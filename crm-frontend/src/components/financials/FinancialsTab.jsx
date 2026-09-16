import { useState, useEffect, useCallback } from "react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayDealExpenses from "@/api/railway/dealExpenses";
import * as railwayDealExpensePayments from "@/api/railway/dealExpensePayments";
import * as railwayDealCommissions from "@/api/railway/dealCommissions";
import * as railwayDealLoanPayments from "@/api/railway/dealLoanPayments";
import * as railwayActivities from "@/api/railway/activities";
import * as railwayDealFinancials from "@/api/railway/dealFinancials";
import { useAuth } from "@/lib/AuthContext";
import { computeFinancials } from "@/lib/financialCalc";
import FinancialSummary from "./FinancialSummary";
import RevenueSection from "./RevenueSection";
import LeadCostSection from "./LeadCostSection";
import CommissionSection from "./CommissionSection";
import ExpensesSection from "./ExpensesSection";
import LoanPaymentsSection from "./LoanPaymentsSection";
import FinancialActivitySection from "./FinancialActivitySection";

export default function FinancialsTab({ deal, lead, invoices, setDeal }) {
  const { user } = useAuth();
  const role = user?.role;
  const isAdmin = role === "admin";
  const isManager = role === "manager";
  const isSalesRep = role === "sales_rep";
  const canViewFull = isAdmin || isManager;
  const canEdit = isAdmin || isManager;
  const canEditLeadCost = isAdmin;
  const canApproveCommission = isAdmin;
  const canDelete = isAdmin;

  const [expenses, setExpenses] = useState([]);
  const [expensePayments, setExpensePayments] = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [loanPayments, setLoanPayments] = useState([]);
  const [activities, setActivities] = useState([]);
  const [saleInvoices, setSaleInvoices] = useState([]);
  const [waterfall, setWaterfall] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    try {
      const [exRes, payRes, comRes, loanRes, actRes, finRes] = await Promise.all([
        canViewFull ? railwayDealExpenses.list({ deal_id: deal.id }) : Promise.resolve({ items: [] }),
        canViewFull ? railwayDealExpensePayments.list({ deal_id: deal.id }) : Promise.resolve({ items: [] }),
        railwayDealCommissions.list({ deal_id: deal.id }).catch(() => ({ items: [] })),
        canViewFull ? railwayDealLoanPayments.list({ deal_id: deal.id }) : Promise.resolve({ items: [] }),
        canViewFull && deal.lead_id ? railwayActivities.list({ lead_id: deal.lead_id }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        // Sale-scoped QB invoices from qb_invoice_sale_map + qb_invoices_cache.
        // QuickBooks is authoritative — no customer-level fallback, no double counting.
        railwayDealFinancials.getFinancials(deal.id, deal.amount).catch(() => null),
      ]);
      setExpenses(exRes.items || []);
      setExpensePayments(payRes.items || []);
      setCommissions(comRes.items || []);
      setLoanPayments(loanRes.items || []);
      setActivities((actRes.items || []).filter((a) => a.metadata?.category === "financial"));
      setSaleInvoices(finRes?.invoices || []);
      setWaterfall(finRes?.waterfall || null);
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [deal?.id, deal?.lead_id, deal?.amount, canViewFull]);

  useEffect(() => {
    load();
  }, [load]);

  const updateDeal = async (fields) => {
    const updateRes = await railwayDeals.update(deal.id, fields);
    // Backend returns { deal: serializeDeal(...) } — unwrap before using as
    // the deal object (matches the same pattern already used in
    // pages/DealDetail.jsx). Without this, deal state after any update made
    // from the Financials tab would become { deal: {...} } instead of the
    // actual deal fields.
    const unwrapped = updateRes?.deal || updateRes;
    setDeal(unwrapped);
    return unwrapped;
  };

  const logActivity = useCallback(
    async (action, recordType, description, extra = {}) => {
      if (!deal?.lead_id) return;
      try {
        await railwayActivities.create({
          lead_id: deal.lead_id,
          type: "note",
          timestamp: new Date().toISOString(),
          content: description,
          author: user?.email || "system",
          metadata: { category: "financial", action, record_type: recordType, deal_id: deal.id, ...extra },
          source: "manual",
        });
      } catch {
        // non-critical — financial action already succeeded
      }
    },
    [deal?.lead_id, deal?.id, user?.email]
  );

  const fin = computeFinancials({ deal, lead, invoices, saleInvoices, expenses, commissions, loanPayments, waterfall });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (isSalesRep) {
    return (
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
        <CommissionSection
          deal={deal}
          commissions={commissions}
          ctx={fin.ctx}
          canEdit={false}
          canApprove={false}
          canDelete={false}
          onChange={load}
          logActivity={logActivity}
          user={user}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
      <FinancialSummary fin={fin} />
      <RevenueSection deal={deal} fin={fin} canEdit={canEdit} updateDeal={updateDeal} logActivity={logActivity} />
      <LeadCostSection deal={deal} fin={fin} canEdit={canEditLeadCost} updateDeal={updateDeal} logActivity={logActivity} />
      <CommissionSection
        deal={deal}
        commissions={commissions}
        ctx={fin.ctx}
        canEdit={canEdit}
        canApprove={canApproveCommission}
        canDelete={canDelete}
        onChange={load}
        logActivity={logActivity}
        user={user}
      />
      <ExpensesSection deal={deal} expenses={expenses} payments={expensePayments} canEdit={canEdit} canDelete={canDelete} onChange={load} logActivity={logActivity} user={user} />
      <LoanPaymentsSection deal={deal} loanPayments={loanPayments} canEdit={canEdit} canDelete={canDelete} onChange={load} logActivity={logActivity} user={user} />
      <FinancialActivitySection activities={activities} />
    </div>
  );
}