/**
 * DealHeader — breadcrumb, title, stage badge, actions, progress bar.
 */
import { Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, TrendingUp } from "lucide-react";

const PIPELINE_STAGES = [
  "Sold / Estimate Approved",
  "Deposit Due",
  "Deposit Paid",
  "Work Scheduled",
  "Work Started",
  "Progress Payment Due",
  "Progress Payment Paid",
  "Final Payment Due",
  "Final Payment Paid",
  "Job Completed",
];

const STAGE_COLORS = {
  "Sold / Estimate Approved": { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-blue-200" },
  "Deposit Due":              { bg: "bg-amber-100",   text: "text-amber-700",   border: "border-amber-200" },
  "Deposit Paid":             { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  "Work Scheduled":           { bg: "bg-sky-100",     text: "text-sky-700",     border: "border-sky-200" },
  "Work Started":             { bg: "bg-indigo-100",  text: "text-indigo-700",  border: "border-indigo-200" },
  "Progress Payment Due":     { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200" },
  "Progress Payment Paid":    { bg: "bg-teal-100",    text: "text-teal-700",    border: "border-teal-200" },
  "Final Payment Due":        { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200" },
  "Final Payment Paid":       { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  "Job Completed":            { bg: "bg-green-100",   text: "text-green-700",   border: "border-green-200" },
};

const fmtMoney = (v) => v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : "—";

export default function DealHeader({ deal, lead, onAddProject, onDeleteDeal }) {
  const stageColor = STAGE_COLORS[deal.stage] || { bg: "bg-slate-100", text: "text-slate-600", border: "border-slate-200" };
  const stageIndex = PIPELINE_STAGES.indexOf(deal.stage);

  return (
    <div className="bg-white border-b border-slate-200 flex-shrink-0 sticky top-0 z-30" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {/* Breadcrumb */}
      <div className="px-4 md:px-6 pt-3 md:pt-4 pb-0 flex items-center gap-2">
        <Link to="/deals" className="flex items-center justify-center w-11 h-11 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors flex-shrink-0 md:hidden" aria-label="Back to deals">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Link to="/deals" className="hidden md:flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-700 btn-compact">
          <ArrowLeft className="w-3.5 h-3.5" />
          Deals
        </Link>
        <span className="text-slate-300 text-xs">/</span>
        {lead && (
          <>
            <Link to={`/leads/${lead.id}`} className="text-xs font-semibold text-amber-600 hover:text-amber-700">
              {lead.first_name} {lead.last_name}
            </Link>
            <span className="text-slate-300 text-xs">/</span>
          </>
        )}
        <span className="text-xs font-semibold text-slate-600 truncate">{deal.name}</span>
      </div>

      {/* Title & Status */}
      <div className="px-4 md:px-6 py-3 md:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 md:gap-4">
        <div className="flex items-start gap-3 md:gap-4 min-w-0">
          <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center flex-shrink-0">
            <TrendingUp className="w-5 h-5 md:w-6 md:h-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg md:text-2xl font-bold text-slate-900 leading-tight truncate">{deal.name}</h1>
            <div className="flex items-center gap-2 mt-1.5 md:mt-2 flex-wrap">
              <span className={`text-xs font-semibold px-2.5 md:px-3 py-1 md:py-1.5 rounded-full border ${stageColor.bg} ${stageColor.text} ${stageColor.border}`}>
                {deal.stage}
              </span>
              {deal.amount && (
                <span className="text-sm font-bold text-emerald-700">{fmtMoney(deal.amount)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={onAddProject}
            className="px-3 md:px-4 py-2 text-xs font-semibold text-amber-600 hover:bg-amber-50 rounded-lg border border-amber-200 transition-colors flex items-center gap-1.5 btn-compact">
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add Project</span>
            <span className="sm:hidden">Add</span>
          </button>
          <button onClick={onDeleteDeal}
            className="px-3 md:px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg border border-red-200 transition-colors flex items-center gap-1.5 btn-compact">
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="px-4 md:px-6 pb-3 md:pb-4">
        <div className="flex items-center gap-0.5">
          {PIPELINE_STAGES.map((s, i) => {
            const isPast = i < stageIndex;
            const isCurrent = i === stageIndex;
            return (
              <div key={s} title={s}
                className={`flex-1 h-2 rounded-full transition-all ${isCurrent ? "bg-amber-500" : isPast ? "bg-amber-200" : "bg-slate-200"}`}
              />
            );
          })}
        </div>
        <p className="text-[10px] text-slate-400 mt-1">
          Step {Math.max(0, stageIndex) + 1} of {PIPELINE_STAGES.length}
        </p>
      </div>
    </div>
  );
}