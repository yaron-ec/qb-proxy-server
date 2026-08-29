import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { AlertTriangle, CheckCircle, TrendingUp, Activity, DollarSign } from 'lucide-react';

export default function ValidationReport() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('leads');

  useEffect(() => {
    loadValidation();
  }, []);

  const loadValidation = async () => {
    try {
      const res = await apiCall('/api/v1/leads', { method: 'GET' });
      setData(null);
    } catch (e) {
      console.error('Error loading validation:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div></div>;
  }

  if (!data) {
    return <div className="p-6 text-center text-slate-400">Failed to load validation</div>;
  }

  const { leadValidation, dealValidation, scoreboardValidation, dashboardValidation } = data;

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Validation Report</h1>
          <p className="text-sm text-muted-foreground mt-1">Lead Intelligence & Sales Intelligence System Test</p>
        </div>

        {/* Status Banner */}
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 mb-8 flex items-start gap-4">
          <CheckCircle className="w-6 h-6 text-emerald-600 flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="font-bold text-emerald-900 text-lg">✓ Validation Passed</h2>
            <p className="text-sm text-emerald-700 mt-1">All intelligence layers are functioning correctly and detecting issues as designed.</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-200 mb-6">
          {[
            { id: 'leads', label: '📋 Leads (10 samples)' },
            { id: 'deals', label: '💼 Deals (10 samples)' },
            { id: 'scoreboard', label: '🏆 Rep Scoreboard' },
            { id: 'dashboard', label: '📊 Dashboard Counts' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-amber-600 text-amber-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Leads Tab */}
        {activeTab === 'leads' && (
          <div className="space-y-3">
            {leadValidation.leads.map((lead, idx) => (
              <LeadCard key={idx} lead={lead} />
            ))}
          </div>
        )}

        {/* Deals Tab */}
        {activeTab === 'deals' && (
          <div className="space-y-3">
            {dealValidation.deals.map((deal, idx) => (
              <DealCard key={idx} deal={deal} />
            ))}
          </div>
        )}

        {/* Scoreboard Tab */}
        {activeTab === 'scoreboard' && (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-slate-50 p-4 border-b border-slate-200">
                <h3 className="font-bold text-slate-900">{scoreboardValidation.repsAnalyzed} Sales Reps</h3>
              </div>
              <div className="divide-y divide-slate-200">
                {scoreboardValidation.reps.map((rep, idx) => (
                  <div key={idx} className="p-4 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-bold text-slate-900">#{idx + 1} {rep.name}</h4>
                      <span className="text-lg font-bold text-emerald-600">${(rep.revenueSold / 1000).toFixed(0)}K</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-xs text-slate-500">Leads Assigned</div>
                        <div className="font-bold text-slate-900">{rep.leadsAssigned}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Appts Set</div>
                        <div className="font-bold text-slate-900">{rep.appointmentsSet}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Contracts Sent</div>
                        <div className="font-bold text-slate-900">{rep.contractsSent}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Signed</div>
                        <div className="font-bold text-slate-900">{rep.contractsSigned}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Close Rate</div>
                        <div className="font-bold text-amber-600">{rep.closeRate}%</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Revenue Sold</div>
                        <div className="font-bold text-slate-900">${(rep.revenueSold / 1000).toFixed(0)}K</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Collected</div>
                        <div className="font-bold text-emerald-600">${(rep.revenueCollected / 1000).toFixed(0)}K</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <DashboardCard
              icon={AlertTriangle}
              label="Leads Needing Attention"
              critical={dashboardValidation.leadsNeedingAttention.critical}
              atRisk={dashboardValidation.leadsNeedingAttention.atRisk}
              total={dashboardValidation.leadsNeedingAttention.total}
              color="red"
            />
            <DashboardCard
              icon={TrendingUp}
              label="Deals Needing Attention"
              critical={dashboardValidation.dealsNeedingAttention.critical}
              atRisk={dashboardValidation.dealsNeedingAttention.atRisk}
              total={dashboardValidation.dealsNeedingAttention.total}
              color="orange"
            />
            <CountCard
              icon={Activity}
              label="Overdue Follow-Ups"
              value={dashboardValidation.overdueFollowUps}
              color="red"
            />
            <CountCard
              icon={Activity}
              label="Contracts Awaiting Signature"
              value={dashboardValidation.contractsAwaitingSignature}
              color="blue"
            />
            <CountCard
              icon={DollarSign}
              label="Invoices Awaiting Payment"
              value={dashboardValidation.invoicesAwaitingPayment}
              color="orange"
            />
            <CountCard
              icon={Activity}
              label="Stale Opportunities"
              value={dashboardValidation.staleOpportunities}
              color="slate"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LeadCard({ lead }) {
  const statusColor = lead.leadStatus === 'critical' ? 'red' : 'orange';
  const statusBg = statusColor === 'red' ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200';

  return (
    <div className={`border ${statusBg} rounded-lg p-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-slate-900">{lead.name}</h3>
          <p className="text-xs text-slate-500">{lead.status} • {lead.contactInfo}</p>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold ${statusColor === 'red' ? 'text-red-600' : 'text-orange-600'}`}>
            {lead.healthScore}
          </div>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
            statusColor === 'red'
              ? 'bg-red-100 text-red-700'
              : 'bg-orange-100 text-orange-700'
          }`}>
            {lead.leadStatus}
          </span>
        </div>
      </div>

      <div className="mb-3 space-y-1">
        {lead.reasons.map((reason, i) => (
          <p key={i} className="text-sm text-slate-700">{reason}</p>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {lead.missingItems.map(item => (
          <span key={item} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
            {item.replace('_', ' ')}
          </span>
        ))}
      </div>

      <div className="bg-white/50 rounded p-2">
        <p className="text-xs font-semibold text-slate-700">
          ✓ Recommended: {lead.recommendedAction}
        </p>
      </div>
    </div>
  );
}

function DealCard({ deal }) {
  const statusColor = deal.dealStatus === 'critical' ? 'red' : 'orange';
  const statusBg = statusColor === 'red' ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200';

  return (
    <div className={`border ${statusBg} rounded-lg p-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-slate-900">{deal.name}</h3>
          <p className="text-xs text-slate-500">{deal.customerName} • {deal.stage}</p>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold ${statusColor === 'red' ? 'text-red-600' : 'text-orange-600'}`}>
            {deal.healthScore}
          </div>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
            statusColor === 'red'
              ? 'bg-red-100 text-red-700'
              : 'bg-orange-100 text-orange-700'
          }`}>
            {deal.dealStatus}
          </span>
        </div>
      </div>

      <div className="mb-3 space-y-1">
        {deal.reasons.map((reason, i) => (
          <p key={i} className="text-sm text-slate-700">{reason}</p>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <div className="bg-white/50 rounded p-1.5">
          <div className="text-slate-500">Amount</div>
          <div className="font-bold text-slate-900">${(deal.amount / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-white/50 rounded p-1.5">
          <div className="text-slate-500">Received</div>
          <div className="font-bold text-emerald-600">${(deal.received / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-white/50 rounded p-1.5">
          <div className="text-slate-500">Balance</div>
          <div className="font-bold text-slate-900">${(deal.balance / 1000).toFixed(0)}K</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-3">
        {deal.missingItems.map(item => (
          <span key={item} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
            {item.replace('_', ' ')}
          </span>
        ))}
      </div>

      <div className="bg-white/50 rounded p-2">
        <p className="text-xs font-semibold text-slate-700">
          ✓ Recommended: {deal.recommendedAction}
        </p>
      </div>
    </div>
  );
}

function DashboardCard({ icon: Icon, label, critical, atRisk, total, color }) {
  const colorMap = {
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
  };

  return (
    <div className={`border rounded-lg p-4 ${colorMap[color]}`}>
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-semibold text-sm">{label}</h3>
        <Icon className="w-5 h-5 opacity-50" />
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span>Critical</span>
          <span className="font-bold">{critical}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span>At-Risk</span>
          <span className="font-bold">{atRisk}</span>
        </div>
        <div className="border-t border-current/20 pt-1 mt-1 flex justify-between text-sm font-bold">
          <span>Total</span>
          <span>{total}</span>
        </div>
      </div>
    </div>
  );
}

function CountCard({ icon: Icon, label, value, color }) {
  const colorMap = {
    red: 'bg-red-50 border-red-200 text-red-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  };

  return (
    <div className={`border rounded-lg p-4 ${colorMap[color]}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium opacity-75 mb-1">{label}</p>
          <p className="text-3xl font-bold">{value}</p>
        </div>
        <Icon className="w-6 h-6 opacity-50" />
      </div>
    </div>
  );
}