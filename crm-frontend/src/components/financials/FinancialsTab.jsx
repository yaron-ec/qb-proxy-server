import { useState, useEffect, useCallback } from "react";
import { PieChart, TrendingUp, Percent, Receipt, Landmark, FileText, Clock } from "lucide-react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayDealExpenses from "@/api/railway/dealExpenses";
import * as railwayDealExpensePayments from "@/api/railway/dealExpensePayments";
import * as railwayDealCommissions from "@/api/railway/dealCommissions";
import * as railwayDealLoanPayments from "@/api/railway/dealLoanPayments";
import * as railwayActivities from "@/api/railway/activities";
import * as railwayDealFinancials from "@/api/railway/dealFinancials";
import { useAuth } from "@/lib/AuthContext";
import { computeFinancials } from "@/lib/financialCalc";
import { AccordionItem, AccordionContent } from "@/components/DesignSystem/Accordion";
import ProfitabilitySummary from "./ProfitabilitySummary";
import CustomerCollections, { PaymentScheduleSection } from "./CustomerCollections";
import CostBreakdown from "./CostBreakdown";
import RevenueSection from "./RevenueSection";
import LeadCostSection from "./LeadCostSection";
import CommissionSection from "./CommissionSection";
import ExpensesSection from "./ExpensesSection";
import LoanPaymentsSection from "./LoanPaymentsSection";
import FinancialActivitySection from "./FinancialActivitySection";
import InvoiceMappingPanel from "./InvoiceMappingPanel";
import AddendumPanel from "./AddendumPanel";

// Expandable Details (November 2026 redesign): everything beyond the simple
// Financial Summary + Collections/Payment Schedule up top is grouped into
// clearly-labeled, collapsed-by-default accordion sections — a long,
// always-rendered wall of every sub-panel is exactly what the redesign's
// "simple summary first, details on demand" requirement replaces. Collapse
// state lives in sessionStorage per deal so re-opening the same deal in the
// same tab keeps a rep's chosen sections open, without persisting across
// deals or devices.

export default function FinancialsTab({ deal, lead, invoices, setDeal, setLead, refreshLead }) {
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
  const [waterfallError, setWaterfallError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Per-deal, per-tab (sessionStorage, not localStorage — never persists
  // across devices/sessions) remembered open/closed state for the
  // Expandable Details accordion, so re-opening the same deal in the same
  // browser tab keeps a rep's chosen sections open instead of re-collapsing
  // everything on every navigation.
  const storageKey = deal?.id ? `fin-details-open:${deal.id}` : null;
  const [openSections, setOpenSections] = useState(() => {
    if (!storageKey) return {};
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  });
  const toggleSection = (key) => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        if (storageKey) sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // sessionStorage unavailable (private mode, quota) — in-memory state still works for this session
      }
      return next;
    });
  };

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
      setWaterfallError(finRes?.waterfallError || null);
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

  // Sales reps see customer-facing collections (what's owed, what's been
  // paid, payment schedule, QuickBooks status) and their own commission —
  // never job cost/profit data, which stays management-only. This preserves
  // the visibility boundary the previous separate "Financial"/"Financials"
  // tabs each enforced independently.
  if (isSalesRep) {
    return (
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-5 space-y-5">
        <CustomerCollections
          deal={deal} lead={lead} fin={fin}
          waterfallError={waterfallError}
          setDeal={setDeal} setLead={setLead}
        />
        <PaymentScheduleSection
          deal={deal} lead={lead}
          invoices={invoices} saleInvoices={saleInvoices} waterfall={waterfall}
          setDeal={setDeal} refreshLead={refreshLead}
        />
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

  // Badge counts for the Expandable Details accordion — a quick scannable
  // signal of how much is inside a collapsed section without opening it.
  const sectionBadges = {
    commissions: commissions.length,
    expenses: expenses.length,
    loan_payments: loanPayments.length,
    activity_log: activities.length,
  };

  // ONE deal, one financial picture — admin/manager see the full
  // profitability view (everything sales_rep sees above, plus cost/profit).
  return (
    <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-5 space-y-6">
      {/* Simple financial summary first (the one plain-English answer to
          "what's the state of this job's money?"), then the collections/
          payment-schedule most people check right after it, both ALWAYS
          visible — everything else (cost breakdown, revenue/lead-cost
          configuration, commissions, expenses, loan payments, documents/QB
          mapping, activity log) lives in the Expandable Details accordion
          below, collapsed by default, so the page opens as a summary, not a
          wall of every sub-panel at once. */}
      <ProfitabilitySummary fin={fin} />

      <div data-testid="fin-collections-section">
        <CustomerCollections
          deal={deal} lead={lead} fin={fin}
          waterfallError={waterfallError}
          setDeal={setDeal} setLead={setLead}
        />
      </div>

      <PaymentScheduleSection
        deal={deal} lead={lead}
        invoices={invoices} saleInvoices={saleInvoices} waterfall={waterfall}
        setDeal={setDeal} refreshLead={refreshLead}
      />

      <div>
        <p className="text-sm font-bold text-slate-800 mb-3">Expandable Details</p>
        <div className="space-y-2" data-testid="fin-expandable-details">
          <AccordionItem
            title="Cost Breakdown" icon={PieChart} color="blue"
            isOpen={!!openSections.cost_breakdown} onToggle={() => toggleSection("cost_breakdown")}
          >
            <AccordionContent>
              <CostBreakdown fin={fin} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            title="Revenue & Lead Cost" icon={TrendingUp} color="emerald"
            isOpen={!!openSections.revenue_lead_cost} onToggle={() => toggleSection("revenue_lead_cost")}
          >
            <AccordionContent>
              <div className="space-y-4">
                <RevenueSection deal={deal} fin={fin} canEdit={canEdit} updateDeal={updateDeal} logActivity={logActivity} />
                <LeadCostSection deal={deal} fin={fin} canEdit={canEditLeadCost} updateDeal={updateDeal} logActivity={logActivity} />
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            title="Commissions" icon={Percent} color="purple" badge={sectionBadges.commissions}
            isOpen={!!openSections.commissions} onToggle={() => toggleSection("commissions")}
          >
            <AccordionContent>
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
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            title="Expenses" icon={Receipt} color="amber" badge={sectionBadges.expenses}
            isOpen={!!openSections.expenses} onToggle={() => toggleSection("expenses")}
          >
            <AccordionContent>
              <ExpensesSection deal={deal} expenses={expenses} payments={expensePayments} canEdit={canEdit} canDelete={canDelete} onChange={load} logActivity={logActivity} user={user} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            title="Loan Payments" icon={Landmark} color="blue" badge={sectionBadges.loan_payments}
            isOpen={!!openSections.loan_payments} onToggle={() => toggleSection("loan_payments")}
          >
            <AccordionContent>
              <LoanPaymentsSection deal={deal} loanPayments={loanPayments} canEdit={canEdit} canDelete={canDelete} onChange={load} logActivity={logActivity} user={user} />
            </AccordionContent>
          </AccordionItem>

          {canViewFull && (
            <AccordionItem
              title="Documents & QuickBooks Mapping" icon={FileText} color="emerald"
              isOpen={!!openSections.documents_mapping} onToggle={() => toggleSection("documents_mapping")}
            >
              <AccordionContent>
                <div className="space-y-4">
                  <AddendumPanel deal={deal} lead={lead} isAdmin={isAdmin} onChange={load} />
                  <InvoiceMappingPanel lead={lead} canEdit={isAdmin} />
                </div>
              </AccordionContent>
            </AccordionItem>
          )}

          <AccordionItem
            title="Activity Log" icon={Clock} color="amber" badge={sectionBadges.activity_log}
            isOpen={!!openSections.activity_log} onToggle={() => toggleSection("activity_log")}
          >
            <AccordionContent>
              <FinancialActivitySection activities={activities} />
            </AccordionContent>
          </AccordionItem>
        </div>
      </div>
    </div>
  );
}