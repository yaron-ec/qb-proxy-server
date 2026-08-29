import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { apiCall } from "@/api/railway/client";
import { ArrowLeft, TrendingUp, Briefcase, CheckCircle, Clock } from "lucide-react";
import { CRMSectionHeader, CRMDataValue, CRMFieldLabel } from "@/components/crm";

const fmtMoney = (v) => v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : "—";
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export default function CustomerProfile() {
  const { id } = useParams(); // lead_id
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [id]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [leadData, dealsData] = await Promise.all([
        apiCall(`/api/v1/leads/${id}`, { method: 'GET' }).catch(() => null),
        apiCall(`/api/v1/deals?lead_id=${id}`, { method: 'GET' })
          .then(r => Array.isArray(r) ? r : (r?.items || []))
          .catch(() => []),
      ]);
      setLead(leadData);
      setDeals(dealsData.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)));
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-amber-500 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-slate-50 gap-3">
        <TrendingUp className="w-12 h-12 text-slate-300" />
        <p className="text-base font-semibold text-slate-600">Customer not found</p>
        <Link to="/deals" className="text-xs text-amber-600 hover:underline">Back to Deals</Link>
      </div>
    );
  }

  const totalRevenue = deals.reduce((sum, d) => sum + (d.amount || 0), 0);
  const totalDeals = deals.length;
  const activeProjects = deals.filter(d => !["Completed", "Job Completed"].includes(d.stage)).length;
  const completedProjects = deals.filter(d => ["Completed", "Job Completed"].includes(d.stage)).length;
  const firstProjectDate = deals.length > 0 ? deals[deals.length - 1].created_date : null;
  const lastProjectDate = deals.length > 0 ? deals[0].created_date : null;

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
      {/* HEADER */}
      <div className="bg-white border-b border-slate-200 flex-shrink-0">
        <div className="px-6 pt-4 pb-0 flex items-center gap-2">
          <Link
            to="/deals"
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-700"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Deals
          </Link>
          <span className="text-slate-300 text-xs">/</span>
          <span className="text-xs font-semibold text-slate-600 truncate">Customer Profile</span>
        </div>

        <div className="px-6 py-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-bold text-white">{lead.first_name?.[0]}{lead.last_name?.[0]}</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-slate-900 leading-tight">{lead.first_name} {lead.last_name}</h1>
              <p className="text-sm text-slate-500 mt-1">{lead.email || lead.phone || "—"}</p>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 overflow-y-auto pb-8">
        <div className="max-w-4xl mx-auto px-6 pt-6 space-y-6">
          
          {/* METRICS */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Total Revenue" value={fmtMoney(totalRevenue)} icon={TrendingUp} />
            <MetricCard label="Total Deals" value={totalDeals.toString()} icon={Briefcase} />
            <MetricCard label="Active Projects" value={activeProjects.toString()} icon={Clock} />
            <MetricCard label="Completed Projects" value={completedProjects.toString()} icon={CheckCircle} />
          </div>

          {/* TIMELINE */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <CRMSectionHeader className="mb-3">Timeline</CRMSectionHeader>
            <div className="space-y-2">
              {firstProjectDate && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>First Project</CRMFieldLabel>
                  <CRMDataValue>{fmtDate(firstProjectDate)}</CRMDataValue>
                </div>
              )}
              {lastProjectDate && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>Last Project</CRMFieldLabel>
                  <CRMDataValue>{fmtDate(lastProjectDate)}</CRMDataValue>
                </div>
              )}
            </div>
          </div>

          {/* PROJECTS LIST */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <CRMSectionHeader>All Projects</CRMSectionHeader>
            </div>
            
            {deals.length === 0 ? (
              <div className="px-4 py-6 text-center text-slate-400 text-sm">
                No projects yet
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {deals.map(deal => (
                  <Link
                    key={deal.id}
                    to={`/deals/${deal.id}`}
                    className="px-4 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between group"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 group-hover:text-amber-600">{deal.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {deal.stage || "—"} • {fmtDate(deal.sold_date || deal.created_date)}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className="text-sm font-bold text-slate-900">{fmtMoney(deal.amount)}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{deal.assigned_rep || "—"}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* CUSTOMER INFO */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <CRMSectionHeader className="mb-3">Contact Information</CRMSectionHeader>
            <div className="space-y-2">
              {lead.email && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>Email</CRMFieldLabel>
                  <CRMDataValue>{lead.email}</CRMDataValue>
                </div>
              )}
              {lead.phone && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>Phone</CRMFieldLabel>
                  <CRMDataValue>{lead.phone}</CRMDataValue>
                </div>
              )}
              {lead.property_address && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>Address</CRMFieldLabel>
                  <CRMDataValue>{lead.property_address}</CRMDataValue>
                </div>
              )}
              {lead.city && (
                <div className="flex items-center justify-between">
                  <CRMFieldLabel>City</CRMFieldLabel>
                  <CRMDataValue>{lead.city}</CRMDataValue>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon: Icon }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{label}</p>
      <p className="text-base font-bold text-slate-900">{value}</p>
    </div>
  );
}