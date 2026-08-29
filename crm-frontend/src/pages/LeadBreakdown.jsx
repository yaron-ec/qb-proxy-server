import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Search, TrendingUp, TrendingDown, AlertCircle, ArrowRight } from "lucide-react";
import { CARD, SPINNER, STATUS_STYLES } from "@/lib/design-system";

const LEAD_STATUS_COLORS = {
  'New': 'bg-blue-100 text-blue-700 border border-blue-200',
  'No answer': 'bg-slate-100 text-slate-600 border border-slate-200',
  'Answered, no appointment set': 'bg-amber-100 text-amber-700 border border-amber-200',
  'DNQ': 'bg-orange-100 text-orange-700 border border-orange-200',
  'Lost': 'bg-red-100 text-red-700 border border-red-200',
  'Sold': 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  'Closed Lost': 'bg-red-100 text-red-700 border border-red-200',
};

const TABS = [
  { id: 'new', label: 'New', statuses: ['New'], icon: AlertCircle, color: 'blue' },
  { id: 'no-answer', label: 'No Answer', statuses: ['No answer'], icon: AlertCircle, color: 'slate' },
  { id: 'answered-no-appt', label: 'Answered, No Appt', statuses: ['Answered, no appointment set'], icon: AlertCircle, color: 'amber' },
  { id: 'dnq', label: 'DNQ', statuses: ['DNQ'], icon: TrendingDown, color: 'orange' },
  { id: 'closed-lost', label: 'Closed Lost', statuses: ['Lost', 'Closed Lost'], icon: TrendingDown, color: 'red' },
  { id: 'sold', label: 'Sold', statuses: ['Sold'], icon: TrendingUp, color: 'emerald' },
];

export default function LeadBreakdown() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('new');

  useEffect(() => {
    loadLeads();
    const interval = setInterval(loadLeads, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadLeads = async () => {
    try {
      const res = await apiCall('/api/v1/leads?limit=2000', { method: 'GET' });
      const allLeads = Array.isArray(res) ? res : (res?.items || []);
      const filtered = allLeads.filter(lead => !lead.first_name?.toLowerCase().includes('unknown') && !lead.last_name?.toLowerCase().includes('unknown'));
      setLeads(filtered);
      setLoading(false);
    } catch (e) {
      console.error('Error loading leads:', e);
      setLoading(false);
    }
  };

  const getLeadsByTab = (statuses) => {
    return leads.filter(lead => statuses.includes(lead.status));
  };

  const getFilteredLeads = () => {
    const tab = TABS.find(t => t.id === activeTab);
    if (!tab) return [];

    return getLeadsByTab(tab.statuses)
      .filter(lead => {
        const text = `${lead.first_name} ${lead.last_name} ${lead.email || ''} ${lead.phone || ''}`.toLowerCase();
        return text.includes(searchTerm.toLowerCase());
      })
      .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  };

  const getTabStats = (statuses) => {
    const tabLeads = getLeadsByTab(statuses);
    const count = tabLeads.length;
    const totalValue = tabLeads.reduce((sum, lead) => sum + (lead.estimated_value || 0), 0);
    return { count, totalValue };
  };

  const filteredLeads = getFilteredLeads();
  const currentTab = TABS.find(t => t.id === activeTab);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="mb-5">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Lead Breakdown</h1>
            <p className="text-sm text-slate-500 mt-0.5">Segment leads by lifecycle stage</p>
          </div>

          {/* Tab Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
            {TABS.map(tab => {
              const stats = getTabStats(tab.statuses);
              const colorMap = { blue: 'bg-blue-50 border-blue-200', red: 'bg-red-50 border-red-200', emerald: 'bg-emerald-50 border-emerald-200', slate: 'bg-slate-50 border-slate-200', amber: 'bg-amber-50 border-amber-200', orange: 'bg-orange-50 border-orange-200' };
              const textMap = { blue: 'text-blue-700', red: 'text-red-700', emerald: 'text-emerald-700', slate: 'text-slate-600', amber: 'text-amber-700', orange: 'text-orange-700' };
              const isActive = activeTab === tab.id;
              
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`p-3 rounded-xl border-2 transition-all text-left shadow-sm ${
                    isActive
                      ? `${colorMap[tab.color]} border-current shadow-md`
                      : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-md'
                  }`}
                >
                  <h3 className={`text-xs font-semibold mb-1.5 ${isActive ? textMap[tab.color] : 'text-slate-500'}`}>{tab.label}</h3>
                  <p className="text-xl font-bold text-slate-900">{stats.count}</p>
                  {stats.totalValue > 0 && (
                    <p className="text-[10px] text-slate-500 mt-0.5">${stats.totalValue.toLocaleString()}</p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, email, phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all bg-white"
            />
          </div>
        </div>
      </div>

      {/* Lead Cards Grid */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div>
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-slate-500 text-sm">No leads found in {currentTab?.label}</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredLeads.map(lead => (
              <Link
                key={lead.id}
                to={`/leads/${lead.id}`}
                className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer p-4 flex items-center gap-4 group"
              >
                {/* Avatar */}
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-white">
                    {lead.first_name?.[0]}{lead.last_name?.[0]}
                  </span>
                </div>

                {/* Main Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <h3 className="text-sm font-semibold text-slate-900 truncate">
                      {lead.first_name} {lead.last_name}
                    </h3>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[lead.status] || 'bg-slate-100 text-slate-600'}`}>
                      {lead.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                    {lead.phone && <span>{lead.phone}</span>}
                    {lead.email && <span className="truncate max-w-[180px]">{lead.email}</span>}
                    {lead.city && <span>{lead.city}</span>}
                    {lead.assigned_rep && <span>Owner: {lead.assigned_rep}</span>}
                    {lead.estimated_value && <span className="font-semibold text-slate-700">${lead.estimated_value.toLocaleString()}</span>}
                    {lead.created_date && <span>{new Date(lead.created_date).toLocaleDateString()}</span>}
                  </div>
                </div>

                <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-amber-500 flex-shrink-0 transition-colors" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}