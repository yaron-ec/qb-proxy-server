import { Link } from "react-router-dom";
import { FileText, Eye, Clock } from "lucide-react";

const ESTIMATE_STATUS_COLORS = {
  'Draft': 'bg-slate-100 text-slate-700',
  'Sent': 'bg-blue-100 text-blue-700',
  'Viewed': 'bg-purple-100 text-purple-700',
  'Accepted': 'bg-emerald-100 text-emerald-700',
  'Declined': 'bg-red-100 text-red-700',
};

const SOURCE_BADGE = {
  'Handoff':    'bg-violet-100 text-violet-700',
  'QuickBooks': 'bg-green-100 text-green-700',
  'Manual':     'bg-slate-100 text-slate-600',
};

export default function EstimateCard({ estimate, lead, source = 'Manual' }) {
  const statusColor = ESTIMATE_STATUS_COLORS[estimate.status] || 'bg-slate-100 text-slate-700';
  const sourceBadge = SOURCE_BADGE[source] || SOURCE_BADGE['Manual'];

  return (
    <Link
      to={`/estimates/${estimate.id}`}
      className="card-premium p-5 group hover:shadow-lg transition-all duration-200 cursor-pointer"
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3 flex-1">
          <div className="w-10 h-10 bg-gradient-to-br from-slate-900 to-slate-700 rounded-lg flex items-center justify-center text-white flex-shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900">{estimate.title}</h3>
            {lead && <p className="text-sm text-slate-600">{lead.first_name} {lead.last_name}</p>}
            <span className={`inline-block mt-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${sourceBadge}`}>
              {source}
            </span>
          </div>
        </div>
        <span className={`text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap ${statusColor}`}>
          {estimate.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4 pb-4 border-b border-slate-100">
        <div>
          <p className="text-xs text-slate-600 mb-1">Total Amount</p>
          <p className="font-bold text-slate-900">${(estimate.total || 0).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-slate-600 mb-1">Deposit</p>
          <p className="font-semibold text-slate-900">${(estimate.deposit_amount || 0).toLocaleString()}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-slate-600">
          <Clock className="w-3.5 h-3.5" />
          <span>Valid until {estimate.valid_until ? new Date(estimate.valid_until).toLocaleDateString() : '—'}</span>
        </div>
        <Eye className="w-4 h-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  );
}