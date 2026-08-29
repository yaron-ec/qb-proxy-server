import { formatDate } from "@/lib/financialCalc";

const ACTION_LABELS = {
  expense_added: "Expense Added",
  expense_edited: "Expense Edited",
  expense_deleted: "Expense Deleted",
  expense_payment_added: "Vendor Payment Added",
  loan_payment_added: "Loan Payment Added",
  loan_payment_edited: "Loan Payment Edited",
  loan_payment_deleted: "Loan Payment Deleted",
  lead_cost_changed: "Lead Cost Changed",
  commission_added: "Commission Added",
  commission_edited: "Commission Edited",
  commission_approved: "Commission Approved",
  commission_paid: "Commission Marked Paid",
  commission_deleted: "Commission Deleted",
  revenue_adjusted: "Revenue Manually Adjusted",
};

export default function FinancialActivitySection({ activities }) {
  const sorted = [...activities].sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return (
    <div>
      <p className="typography-section-header mb-2">ACTIVITY HISTORY</p>
      <div className="card-premium p-4">
        {sorted.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-3">No financial activity yet.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((a) => (
              <div key={a.id} className="flex items-start gap-3 text-xs border-b border-slate-50 pb-2 last:border-0 last:pb-0">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-800">{ACTION_LABELS[a.metadata?.action] || a.metadata?.action || "Activity"}</p>
                  <p className="text-slate-600">{a.content}</p>
                  {a.metadata?.record_type && <p className="text-[10px] text-slate-400 mt-0.5">{a.metadata.record_type}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-slate-500">{a.author || "—"}</p>
                  <p className="text-[10px] text-slate-400">{formatDate(a.timestamp)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}