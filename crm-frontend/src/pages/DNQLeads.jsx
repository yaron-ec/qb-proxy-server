import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Search, Phone, Mail, MapPin, User, Calendar, ArrowRight } from "lucide-react";
import { formatPhone, toTitleCase } from "@/lib/formatters";

function fmtCreateDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DNQLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadDNQLeads();
    // Realtime subscribe not available in Railway API — polling fallback
    const interval = setInterval(loadDNQLeads, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadDNQLeads = async () => {
    try {
      const res = await apiCall('/api/v1/leads?limit=2000', { method: 'GET' });
      const allLeads = Array.isArray(res) ? res : (res?.items || []);
      const dnqLeads = allLeads
        .filter(lead => lead.status === 'DNQ')
        .filter(lead => !lead.first_name?.toLowerCase().includes('unknown') && !lead.last_name?.toLowerCase().includes('unknown'));
      setLeads(dnqLeads);
      setLoading(false);
    } catch (e) {
      console.error('Error loading DNQ leads:', e);
      setLoading(false);
    }
  };

  const filteredLeads = leads.filter(lead => {
    const searchText = `${lead.first_name} ${lead.last_name} ${lead.email || ''} ${lead.phone || ''}`.toLowerCase();
    return searchText.includes(searchTerm.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Do Not Qualify (DNQ)</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {filteredLeads.length} lead{filteredLeads.length !== 1 ? 's' : ''} — archived for historical reference
              </p>
            </div>
            <Link
              to="/leads"
              className="text-sm font-semibold text-amber-600 hover:text-amber-700 transition-colors"
            >
              ← Back to Active Leads
            </Link>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search name, email, phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all w-full"
            />
          </div>
        </div>
      </div>

      {/* DNQ Leads List */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-slate-400 mb-2">
              <svg className="w-12 h-12 mx-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm text-slate-500">No DNQ leads yet</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredLeads.map(lead => (
              <DNQLeadCard key={lead.id} lead={lead} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DNQLeadCard({ lead }) {
  const colors = ['bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-green-500', 'bg-orange-500', 'bg-cyan-500'];
  const avatarColor = colors[lead.id.charCodeAt(0) % colors.length];

  return (
    <Link
      to={`/leads/${lead.id}`}
      className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-200 p-4 group block"
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className={`w-10 h-10 rounded-lg ${avatarColor} flex items-center justify-center text-white font-bold text-sm flex-shrink-0 mt-0.5`}>
          {`${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase()}
        </div>

        {/* Main Info */}
        <div className="flex-1 min-w-0">
          {/* Name + Status */}
          <div className="flex items-center gap-2 mb-2.5 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900">{toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}</h3>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
              DNQ
            </span>
            {lead.project_type && (
              <span className="text-xs text-slate-500">{lead.project_type}</span>
            )}
          </div>

          {/* Contact + Location row */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 mb-2">
            {lead.phone && (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-slate-400"><Phone className="w-3 h-3" /></span>
                <span className="font-semibold text-slate-500">Phone:</span>
                <span className="text-slate-700">{formatPhone(lead.phone)}</span>
              </span>
            )}
            {lead.email && (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-slate-400"><Mail className="w-3 h-3" /></span>
                <span className="font-semibold text-slate-500">Email:</span>
                <span className="text-slate-700 truncate max-w-[180px]">{lead.email}</span>
              </span>
            )}
            {lead.city && (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-slate-400"><MapPin className="w-3 h-3" /></span>
                <span className="font-semibold text-slate-500">City:</span>
                <span className="text-slate-700">{toTitleCase(lead.city)}</span>
              </span>
            )}
            {(lead.crm_created_date || lead.created_date) && (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-slate-400"><Calendar className="w-3 h-3" /></span>
                <span className="font-semibold text-slate-500">Added:</span>
                <span className="text-slate-700">{fmtCreateDate(lead.crm_created_date || lead.created_date)}</span>
              </span>
            )}
          </div>

          {/* Source + Notes preview */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 mb-2">
            {lead.source && <span>Source: {lead.source}</span>}
            {lead.assigned_rep && (
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" /> {toTitleCase(lead.assigned_rep)}
              </span>
            )}
          </div>

          {/* Notes preview */}
          {lead.notes && (
            <p className="text-xs text-slate-600 line-clamp-2 mt-2">{lead.notes}</p>
          )}
        </div>

        {/* Arrow */}
        <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-amber-500 flex-shrink-0 transition-colors mt-1" />
      </div>
    </Link>
  );
}