/**
 * lib/dealTimeline.js — pure derivation of the Deal Activity timeline.
 *
 * Deal Activity is the chronological PROJECT HISTORY (Sale -> Contract ->
 * Execution -> Financial/Document events -> Completion), not a generic
 * call/email/note stream. Per the architecture audit, almost every event is
 * DERIVED from data that already exists and is already correctly maintained
 * elsewhere — this module never writes anything, it only reads already-
 * canonical rows and normalizes them into one sorted list. That is also why
 * this is naturally idempotent: recomputing from canonical fields on every
 * request can never produce a "duplicate" event, because nothing is being
 * inserted merely by viewing the timeline.
 *
 * Canonical sources used (see routes/dealTimeline.js for the queries):
 *   - deals row: sold_date, work_start_date, deposit/progress/final payment
 *     amounts+dates, stage, completed_at/completed_by (2026-40 migration),
 *     assigned_rep, created_by, created_at, close_date.
 *   - signnow_documents (lead-scoped): earliest row reaching signed/completed
 *     status -> Contract Signed. (Single assumption, documented: today every
 *     lead's SignNow flow is the sale contract; if a lead later accumulates
 *     other signed SignNow documents, this picks the EARLIEST one, which is
 *     the contract by construction of when it was created.)
 *   - lead_attachments (deal-scoped via the new deal_id column, kind =
 *     'completion_form') -> Completion Form event(s). Every upload is kept
 *     as its own historical fact — a later re-upload does not erase the
 *     record of the earlier one.
 *   - activities (lead-scoped, metadata.deal_id = this deal) -> the
 *     financial/change-order audit trail FinancialsTab already logs via
 *     logActivity for every edit (revenue, expenses, commissions, loan
 *     payments, lead cost). These already exist in production; this module
 *     only classifies/relabels them for the timeline.
 *
 * Deliberately NOT derived (would require fabricating unproven data):
 *   - "Deposit Due" / "Progress Payment Due" / "Final Payment Due" — these
 *     are standing requirements, not a dated thing that happened; only the
 *     PAID variants (which have a real *_paid_date field) become events.
 *   - Per-change-order line items — only the aggregate
 *     financial_change_orders_amount exists; there is no per-change-order
 *     table with individual dates, so this surfaces the EDIT audit trail
 *     (which does have a real created_at) instead of inventing one entry
 *     per dollar change.
 */
'use strict';

const CATEGORIES = ['milestone', 'contract', 'payment', 'change_order', 'financial', 'document', 'completion'];

function isoOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Financial-activity action -> { category, title }. Falls back to a generic
// "Financial Update" for any action not explicitly mapped (forward-compatible
// with a future logActivity call this module doesn't know about yet).
const FINANCIAL_ACTION_LABELS = {
  revenue_adjusted: { category: 'financial', title: 'Revenue Adjusted' },
  lead_cost_changed: { category: 'financial', title: 'Lead Cost Updated' },
  expense_added: { category: 'financial', title: 'Expense Added' },
  expense_edited: { category: 'financial', title: 'Expense Updated' },
  expense_deleted: { category: 'financial', title: 'Expense Removed' },
  expense_payment_added: { category: 'financial', title: 'Expense Payment Recorded' },
  commission_added: { category: 'financial', title: 'Commission Added' },
  commission_edited: { category: 'financial', title: 'Commission Updated' },
  commission_approved: { category: 'financial', title: 'Commission Approved' },
  commission_paid: { category: 'financial', title: 'Commission Paid' },
  commission_deleted: { category: 'financial', title: 'Commission Removed' },
  loan_payment_added: { category: 'financial', title: 'Loan Payment Added' },
  loan_payment_edited: { category: 'financial', title: 'Loan Payment Updated' },
  loan_payment_deleted: { category: 'financial', title: 'Loan Payment Removed' },
};

/**
 * buildDealTimeline — pure. Every argument is already-fetched, already-
 * authorized data (the route does the DB queries + auth check; this module
 * has no DB/network access so it can be unit-tested directly).
 *
 * @param {object} deal - a deals row (snake_case, as returned by the DB)
 * @param {object[]} signnowDocs - signnow_documents rows for deal.lead_id, any order
 * @param {object[]} completionAttachments - lead_attachments rows with
 *   attachment_kind='completion_form' and deal_id = deal.id
 * @param {object[]} financialActivities - activities rows with metadata.deal_id = deal.id
 * @returns {object[]} timeline events, newest first, each:
 *   { id, category, title, date, by, amount, detail, document }
 */
function buildDealTimeline(deal, signnowDocs = [], completionAttachments = [], financialActivities = []) {
  if (!deal) return [];
  const events = [];

  // 1. SALE — every deal has this; sold_date first, created_at as a
  //    fallback so a deal is never missing its first event.
  events.push({
    id: 'deal_sold',
    category: 'milestone',
    title: 'Deal Sold',
    date: isoOrNull(deal.sold_date) || isoOrNull(deal.created_at),
    by: deal.assigned_rep || deal.created_by || null,
    amount: deal.amount != null ? Number(deal.amount) : null,
    detail: null,
    document: null,
  });

  // 2. CONTRACT — earliest SignNow document for this lead that actually
  //    reached signed/completed. Skipped entirely if none exists (no
  //    fabricated date).
  const signed = (signnowDocs || [])
    .filter(d => d.status === 'signed' || d.status === 'completed')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (signed.length > 0) {
    const doc = signed[0];
    events.push({
      id: `contract_signed:${doc.id}`,
      category: 'contract',
      title: 'Contract Signed',
      date: isoOrNull(doc.updated_at) || isoOrNull(doc.created_at),
      by: doc.created_by || null,
      amount: null,
      detail: doc.document_name || null,
      document: doc.pdf_url ? { url: doc.pdf_url, fileName: doc.document_name || 'Signed Contract', fileType: 'application/pdf' } : null,
    });
  }

  // 3. PROJECT EXECUTION — Work Started (a real, user-entered date field —
  //    not derived from an ambiguous "last updated" timestamp).
  if (deal.work_start_date) {
    events.push({
      id: 'work_started',
      category: 'milestone',
      title: 'Work Started',
      date: isoOrNull(deal.work_start_date),
      by: null,
      amount: null,
      detail: null,
      document: null,
    });
  }

  // 4. PAYMENT MILESTONES — only the PAID variants (each has a real
  //    *_paid_date field); "Due" states are standing requirements, not a
  //    dated historical fact, so they are deliberately not events.
  const paymentMilestones = [
    { flag: 'deposit_paid', dateField: 'deposit_paid_date', amountField: 'deposit_paid', id: 'deposit_paid', title: 'Deposit Paid' },
    { flag: 'progress_payment_paid', dateField: 'progress_payment_paid_date', amountField: 'progress_payment_paid', id: 'progress_payment_paid', title: 'Progress Payment Paid' },
    { flag: 'final_payment_paid', dateField: 'final_payment_paid_date', amountField: 'final_payment_paid', id: 'final_payment_paid', title: 'Final Payment Paid' },
  ];
  for (const m of paymentMilestones) {
    const amount = Number(deal[m.amountField]) || 0;
    if (amount > 0 && deal[m.dateField]) {
      events.push({
        id: m.id,
        category: 'payment',
        title: m.title,
        date: isoOrNull(deal[m.dateField]),
        by: null,
        amount,
        detail: null,
        document: null,
      });
    }
  }

  // 5. FINANCIAL / DOCUMENT EVENTS — the audit trail FinancialsTab already
  //    logs on every financial edit (change orders, expenses, commissions,
  //    loan payments, lead cost). Already deal-scoped by the caller's query
  //    (metadata.deal_id = deal.id).
  for (const act of (financialActivities || [])) {
    const action = act.metadata && act.metadata.action;
    const label = FINANCIAL_ACTION_LABELS[action] || { category: 'financial', title: 'Financial Update' };
    // A change-order-specific edit (RevenueSection's "Change orders" field)
    // gets its own category so it can render as a distinct "+" event,
    // matching the task's explicit Change Order example — a manual revenue
    // adjustment (the same action, different field) stays generic financial.
    const category = action === 'revenue_adjusted' && /^Change orders/i.test(act.content || '')
      ? 'change_order'
      : label.category;
    events.push({
      id: `activity:${act.id}`,
      category,
      title: category === 'change_order' ? 'Change Order Updated' : label.title,
      date: isoOrNull(act.created_at),
      by: act.author || null,
      amount: null,
      detail: act.content || null,
      document: null,
    });
  }

  // 6. COMPLETION FORM — every upload is its own immutable historical fact;
  //    a later re-upload does not remove the earlier event.
  for (const att of (completionAttachments || [])) {
    events.push({
      id: `completion_form:${att.id}`,
      category: 'document',
      title: 'Completion Form Uploaded',
      date: isoOrNull(att.uploaded_at) || isoOrNull(att.created_at),
      by: att.uploaded_by || null,
      amount: null,
      detail: att.file_name || null,
      document: { url: att.file_url, fileName: att.file_name, fileType: att.file_type, id: att.id },
    });
  }

  // 7. PROJECT COMPLETION — first-class event, only when the deal has
  //    actually reached Job Completed AND a real date is known.
  //    completed_at (auto-stamped going forward) is authoritative; close_date
  //    is a real, rep-entered fallback for deals that reached Job Completed
  //    before this feature existed. If neither is present, no fabricated
  //    date is shown and the event is omitted entirely.
  if (deal.stage === 'Job Completed') {
    const completedDate = isoOrNull(deal.completed_at) || isoOrNull(deal.close_date);
    if (completedDate) {
      events.push({
        id: 'project_completed',
        category: 'completion',
        title: 'Project Completed',
        date: completedDate,
        by: deal.completed_by || null,
        amount: null,
        detail: null,
        document: null,
      });
    }
  }

  // Drop anything that ended up with no provable date (defensive — every
  // branch above already guards this, but never show an undated event).
  const dated = events.filter(e => !!e.date);

  // Newest first — matches the task's accepted "newest-first is fine as long
  // as chronology is unmistakable" guidance and this CRM's other feeds.
  dated.sort((a, b) => new Date(b.date) - new Date(a.date));
  return dated;
}

module.exports = { buildDealTimeline, CATEGORIES, FINANCIAL_ACTION_LABELS };
