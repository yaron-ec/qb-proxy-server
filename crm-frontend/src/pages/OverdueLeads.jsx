import { useState, useEffect, useMemo } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle, User, Phone, Calendar } from "lucide-react";

function parseLocalDate(dateStr) {
  const m = String(dateStr || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function daysOverdue(dateStr) {
  const dateUTC = parseLocalDate(dateStr);
  if (!dateUTC) return null;
  const todayUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const diffDays = Math.floor((todayUTC - dateUTC) / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 0;
}

export default function OverdueLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterRep, setFilterRep] = useState("");
  const [sortBy, setSortBy] = useState("daysOverdue");

  useEffect(() => {
    const loadData = async () => {
      try {
        const res = await apiCall('/api/v1/leads?limit=10000', { method: 'GET' });
        const allLeads = Array.isArray(res) ? res : (res?.items || []);
        setLeads(allLeads);
        setLoading(false);
      } catch (e) {
        console.error('[OverdueLeads] Error loading data:', e);
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const todayUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

  const overdueLeads = useMemo(() => {
    return leads
      .filter(l =>
        l.follow_up_date &&
        !['Sold', 'Lost'].includes(l.status) &&
        !l.first_name?.toLowerCase().includes('unknown')
      )
      .filter(l => {
        const dateUTC = parseLocalDate(l.follow_up_date);
        return dateUTC && dateUTC < todayUTC;
      })
      .map(l => ({
        ...l,
        daysOverdue: daysOverdue(l.follow_up_date) || 0,
      }))
      .filter(l => !filterRep || l.assigned_rep === filterRep)
      .sort((a, b) => {
        if (sortBy === "daysOverdue") {
          return b.daysOverdue - a.daysOverdue;
        } else if (sortBy === "name") {
          return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
        } else if (sortBy === "rep") {
          return (a.assigned_rep || '').localeCompare(b.assigned_rep || '');
        }
        return 0;
      });
  }, [leads, filterRep, sortBy, todayUTC]);

  const reps = Array.from(new Set(leads.filter(l => l.follow_up_date).map(l => l.assigned_rep || 'Unassigned')))
    .sort();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-red-600 rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="p-6 min-h-full bg-slate-50 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/" className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-red-500" />
            Overdue Follow-ups
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">{overdueLeads.length} leads with overdue follow-ups</p>
        </div>
      </div>

      {/* Controls */}
      {overdueLeads.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Sales Rep</label>
            <select
              value={filterRep}
              onChange={(e) => setFilterRep(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-all"
            >
              <option value="">All Reps ({leads.filter(l => l.follow_up_date).length})</option>
              {reps.map(rep => {
                const count = overdueLeads.filter(l => (l.assigned_rep || 'Unassigned') === rep).length;
                return <option key={rep} value={rep}>{rep} ({count})</option>;
              })}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Sort By</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-all"
            >
              <option value="daysOverdue">Days Overdue (Highest)</option>
              <option value="name">Name (A-Z)</option>
              <option value="rep">Sales Rep (A-Z)</option>
            </select>
          </div>
        </div>
      )}

      {/* List */}
      <div className="space-y-3">
        {overdueLeads.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <AlertTriangle className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">No overdue follow-ups</p>
            <p className="text-xs text-slate-400 mt-1">Great work staying on top of follow-ups! 🎉</p>
          </div>
        ) : (
          overdueLeads.map((lead) => (
            <Link
              key={lead.id}
              to={`/leads/${lead.id}`}
              className="bg-white rounded-xl border border-red-200 hover:border-red-300 hover:shadow-md transition-all overflow-hidden group"
            >
              <div className="p-4 flex items-start gap-4">
                {/* Avatar */}
                <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0 text-sm font-bold text-red-700">
                  {lead.first_name?.[0]}{lead.last_name?.[0]}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div>
                      <p className="text-sm font-semibold text-slate-900 group-hover:text-red-600 transition-colors">
                        {lead.first_name} {lead.last_name}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">{lead.email}</p>
                    </div>
                    <span className="text-xs font-bold text-white bg-red-500 px-2.5 py-1 rounded-full flex-shrink-0 whitespace-nowrap">
                      {lead.daysOverdue} days overdue
                    </span>
                  </div>

                  {/* Details */}
                  <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-500">
                    {lead.follow_up_date && (
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        <span>{new Date(lead.follow_up_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      </div>
                    )}
                    {lead.follow_up_time && (
                      <span>{fmt12(lead.follow_up_time)}</span>
                    )}
                    {lead.follow_up_type && (
                      <span className="px-2 py-0.5 bg-slate-100 rounded">
                        {lead.follow_up_type === 'Meeting' ? '📅' : '📞'} {lead.follow_up_type}
                      </span>
                    )}
                    {lead.phone && (
                      <a href={`tel:${lead.phone}`} onClick={(e) => e.preventDefault()}
                        className="flex items-center gap-1 text-green-600 hover:text-green-700">
                        <Phone className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  {/* Rep & Status */}
                  <div className="flex items-center gap-2 mt-2 text-xs">
                    <User className="w-3 h-3 text-slate-400" />
                    <span className="text-slate-600">{lead.assigned_rep || 'Unassigned'}</span>
                    <span className="text-slate-300">•</span>
                    <span className={`font-medium ${
                      lead.status === 'DNQ' ? 'text-slate-500' :
                      lead.status === 'Sold' ? 'text-green-600' :
                      lead.status === 'Lost' ? 'text-red-600' :
                      'text-slate-600'
                    }`}>
                      {lead.status || 'New'}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}