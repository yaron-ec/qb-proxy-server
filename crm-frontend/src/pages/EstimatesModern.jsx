import { useState, useEffect, useCallback } from "react";
import * as railwayLeads from "@/api/railway/leads";
import { apiCall } from "@/api/railway/client";
import { Plus, Search } from "lucide-react";
import EstimateCard from "@/components/EstimateCard";
import SelectDialog from "@/components/SelectDialog";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import PullToRefreshIndicator from "@/components/PullToRefreshIndicator";

// QB-only test/sample customer names to exclude
const QB_ONLY_NAMES = ['paulsen medical supplies', 'red rock diner', 'geeta kalapatapu', 'test company'];

function isHandoffEstimate(est) {
  const src = (est.source || '').toLowerCase();
  const imported = (est.imported_from || '').toLowerCase();
  const title = (est.title || '').toLowerCase();
  // Has a handoff_estimate_id or project_id (set during handoff import)
  if (est.handoff_estimate_id || est.project_id) return true;
  if (src === 'handoff' || imported === 'handoff') return true;
  return false;
}

function isQBOnly(est) {
  const title = (est.title || '').toLowerCase();
  // Explicit QB test names
  if (QB_ONLY_NAMES.some(n => title.includes(n))) return true;
  // Has a QB estimate ID but no handoff link
  if (est.qb_estimate_id && !est.handoff_estimate_id && !est.project_id) {
    const src = (est.source || '').toLowerCase();
    const imported = (est.imported_from || '').toLowerCase();
    if (src !== 'handoff' && imported !== 'handoff') return true;
  }
  return false;
}

function getEstimateSource(est) {
  const src = (est.source || '').toLowerCase();
  const imported = (est.imported_from || '').toLowerCase();
  if (est.handoff_estimate_id || src === 'handoff' || imported === 'handoff') return 'Handoff';
  if (est.qb_estimate_id) return 'QuickBooks';
  return 'Manual';
}

export default function EstimatesModern() {
  const [estimates, setEstimates] = useState([]);
  const [leads, setLeads] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('handoff');

  const loadData = useCallback(async () => {
    try {
      const [ests, allLeads] = await Promise.all([
        apiCall('/api/v1/estimates?sort=-updated_date&limit=500', { method: 'GET' }).then(r => r.items || []),
        railwayLeads.list({ sort: '-updated_date', limit: 500 }).then(r => r.items || []),
      ]);
      setEstimates(ests);
      const leadsMap = {};
      allLeads.forEach(lead => { leadsMap[lead.id] = lead; });
      setLeads(leadsMap);
      setLoading(false);
    } catch (e) {
      console.error('Error loading data:', e);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => loadData(), 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const { pulling, refreshing, pullDistance } = usePullToRefresh(loadData);

  // All non-QB-only estimates (used for total count)
  const handoffEstimates = estimates.filter(est => !isQBOnly(est));

  const filteredEstimates = handoffEstimates
    .filter(est => {
      if (sourceFilter === 'handoff') return isHandoffEstimate(est);
      if (sourceFilter === 'qb') return getEstimateSource(est) === 'QuickBooks' && !isQBOnly(est);
      if (sourceFilter === 'manual') return getEstimateSource(est) === 'Manual';
      return true; // 'all'
    })
    .filter(est => {
      const lead = leads[est.lead_id];
      const text = `${est.title || ''} ${lead?.first_name || ''} ${lead?.last_name || ''}`.toLowerCase();
      return text.includes(searchTerm.toLowerCase());
    })
    .filter(est => statusFilter === 'all' || est.status === statusFilter);

  return (
    <div className="min-h-screen bg-background">
      <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
      {/* Header */}
      <div className="sticky top-0 z-40 bg-card border-b border-border" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">Estimates</h1>
              <p className="text-sm text-muted-foreground mt-1">{filteredEstimates.length} of {handoffEstimates.length} estimates</p>
            </div>
            <button className="flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg font-semibold transition-all duration-200 active:scale-95">
              <Plus className="w-4 h-4" />
              New Estimate
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search estimates..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
              />
            </div>
            <SelectDialog
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: "handoff", label: "Source: Handoff" },
                { value: "qb", label: "Source: QuickBooks" },
                { value: "manual", label: "Source: Manual" },
                { value: "all", label: "All Sources" },
              ]}
            />
            <SelectDialog
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: "All Statuses" },
                { value: "Draft", label: "Draft" },
                { value: "Sent", label: "Sent" },
                { value: "Viewed", label: "Viewed" },
                { value: "Accepted", label: "Accepted" },
                { value: "Declined", label: "Declined" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Estimates Grid */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-slate-500">Loading estimates...</span>
          </div>
        ) : filteredEstimates.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No estimates found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredEstimates.map(estimate => (
              <EstimateCard 
                key={estimate.id} 
                estimate={estimate} 
                lead={leads[estimate.lead_id]}
                source={getEstimateSource(estimate)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}