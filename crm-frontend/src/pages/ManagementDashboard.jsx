import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { AlertTriangle, TrendingUp, PhoneCall, Calendar, FileText, DollarSign, CheckCircle, Clock, Eye, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

const ISSUE_LABELS = {
  no_appointment: { icon: '📅', label: 'No appointment' },
  no_rep_assigned: { icon: '👤', label: 'No rep assigned' },
  no_estimate: { icon: '📄', label: 'No estimate' },
  no_contract: { icon: '📋', label: 'No contract' },
  no_follow_up: { icon: '⏰', label: 'No follow-up' },
  stale_activity: { icon: '😴', label: 'Stale activity' },
  overdue_follow_up: { icon: '⚠️', label: 'Overdue follow-up' },
  lost_communication: { icon: '📞', label: 'No contact info' },
  no_activity: { icon: '🔇', label: 'No recent activity' },
  stalled_deal: { icon: '🛑', label: 'Deal stalled' },
  payment_overdue: { icon: '💰', label: 'Payment overdue' },
};

export default function ManagementDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const res = await apiCall('/api/v1/leads', { method: 'GET' });
      setData(res?.dashboard || null);
    } catch (e) {
      console.error('Error loading dashboard:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div></div>;
  }

  if (!data) {
    return <div className="p-6 text-center text-slate-400">Failed to load dashboard</div>;
  }

  const { summary, leadsNeedingAttention, dealsNeedingAttention, queues } = data;

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Management Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Team health, action queues, and escalations</p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          <SummaryCard icon={AlertTriangle} label="Critical Leads" value={summary.critical_leads} color="red" />
          <SummaryCard icon={AlertCircle} label="At-Risk Leads" value={summary.at_risk_leads} color="orange" />
          <SummaryCard icon={TrendingUp} label="Critical Deals" value={summary.critical_deals} color="red" />
          <SummaryCard icon={Clock} label="At-Risk Deals" value={summary.at_risk_deals} color="orange" />
          <SummaryCard icon={PhoneCall} label="Actions Today" value={summary.actions_due_today} color="blue" />
          <SummaryCard icon={DollarSign} label="Invoices Overdue" value={summary.invoices_overdue} color="red" />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-200 mb-6">
          {[
            { id: 'overview', label: '📋 Overview' },
            { id: 'today', label: '📅 Today\'s Queue' },
            { id: 'leads', label: '⚠️ Leads Needing Attention' },
            { id: 'deals', label: '💼 Deals Needing Attention' },
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

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Quick Queue Summaries */}
            <div className="grid md:grid-cols-2 gap-4">
              <QueueCard
                title="☎️ Call Today"
                count={queues.call_today.length}
                items={queues.call_today.slice(0, 5).map((item, i) => (
                  <div key={i} className="text-xs py-1 flex justify-between">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-slate-500">{item.time}</span>
                  </div>
                ))}
              />
              <QueueCard
                title="⏰ Follow-up Today"
                count={queues.follow_up_today.length}
                items={queues.follow_up_today.slice(0, 5).map((item, i) => (
                  <div key={i} className="text-xs py-1 flex justify-between">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-slate-500">{item.time}</span>
                  </div>
                ))}
              />
              <QueueCard
                title="📋 Contracts to Send"
                count={queues.contracts_to_send.length}
                items={queues.contracts_to_send.slice(0, 5).map((item, i) => (
                  <Link key={i} to={`/leads/${item.leadId}`} className="text-xs py-1 block hover:text-amber-600">
                    {item.name} <span className="text-slate-400">({item.rep})</span>
                  </Link>
                ))}
              />
              <QueueCard
                title="👁 Contracts Viewed Not Signed"
                count={queues.contracts_viewed_not_signed.length}
                items={queues.contracts_viewed_not_signed.slice(0, 5).map((item, i) => (
                  <Link key={i} to={`/leads/${item.leadId}`} className="text-xs py-1 block hover:text-amber-600">
                    {item.name} <span className="text-slate-400">({item.docName})</span>
                  </Link>
                ))}
              />
              <QueueCard
                title="💰 Invoices Overdue"
                count={queues.invoices_overdue.length}
                items={queues.invoices_overdue.slice(0, 5).map((item, i) => (
                  <div key={i} className="text-xs py-1 flex justify-between">
                    <span className="font-medium">{item.customerName}</span>
                    <span className="text-red-600 font-bold">${item.amount.toLocaleString()}</span>
                  </div>
                ))}
              />
              <QueueCard
                title="🔔 Appointments to Confirm"
                count={queues.appointments_to_confirm.length}
                items={queues.appointments_to_confirm.slice(0, 5).map((item, i) => (
                  <div key={i} className="text-xs py-1 flex justify-between">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-slate-500">{item.time}</span>
                  </div>
                ))}
              />
            </div>
          </div>
        )}

        {/* Today's Queue Tab */}
        {activeTab === 'today' && (
          <div className="space-y-6">
            <ActionQueue title="☎️ Call Today" icon={PhoneCall} items={queues.call_today} />
            <ActionQueue title="⏰ Follow-up Today" icon={Calendar} items={queues.follow_up_today} />
            <ActionQueue title="🔔 Appointments to Confirm" icon={CheckCircle} items={queues.appointments_to_confirm} />
          </div>
        )}

        {/* Leads Needing Attention Tab */}
        {activeTab === 'leads' && (
          <div className="space-y-3">
            {leadsNeedingAttention.length === 0 ? (
              <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-lg border border-slate-200">
                All leads are healthy! 🎉
              </div>
            ) : (
              leadsNeedingAttention.map(lead => (
                <Link
                  key={lead.leadId}
                  to={`/leads/${lead.leadId}`}
                  className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-md transition-all block"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-bold text-slate-900">{lead.name}</h3>
                      <p className="text-xs text-slate-500">{lead.rep}</p>
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${lead.score >= 50 ? 'text-orange-600' : 'text-red-600'}`}>
                        {lead.score}
                      </div>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        lead.status === 'critical'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        {lead.status}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-slate-700 mb-2">{lead.action}</p>
                  <div className="flex flex-wrap gap-1">
                    {lead.issues.slice(0, 3).map(issue => (
                      <span key={issue} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        {ISSUE_LABELS[issue]?.icon} {ISSUE_LABELS[issue]?.label}
                      </span>
                    ))}
                    {lead.issues.length > 3 && (
                      <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        +{lead.issues.length - 3} more
                      </span>
                    )}
                  </div>
                </Link>
              ))
            )}
          </div>
        )}

        {/* Deals Needing Attention Tab */}
        {activeTab === 'deals' && (
          <div className="space-y-3">
            {dealsNeedingAttention.length === 0 ? (
              <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-lg border border-slate-200">
                All deals are progressing well! 🎯
              </div>
            ) : (
              dealsNeedingAttention.map(deal => (
                <Link
                  key={deal.dealId}
                  to={`/deals/${deal.dealId}`}
                  className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-md transition-all block"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-bold text-slate-900">{deal.dealName}</h3>
                      <p className="text-xs text-slate-500">{deal.customerName} • {deal.stage}</p>
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${deal.score >= 50 ? 'text-orange-600' : 'text-red-600'}`}>
                        {deal.score}
                      </div>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        deal.status === 'critical'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        {deal.status}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-slate-700 mb-2">{deal.action}</p>
                  <div className="flex flex-wrap gap-1">
                    {deal.issues.slice(0, 3).map(issue => (
                      <span key={issue} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        {ISSUE_LABELS[issue]?.icon} {ISSUE_LABELS[issue]?.label}
                      </span>
                    ))}
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, color }) {
  const colorMap = {
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
  };

  return (
    <div className={`rounded-lg border p-4 text-center ${colorMap[color]}`}>
      <Icon className="w-5 h-5 mx-auto mb-1" />
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] font-medium">{label}</div>
    </div>
  );
}

function QueueCard({ title, count, items }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <span className="text-sm font-bold text-amber-600">{count}</span>
      </div>
      <div className="space-y-0.5">
        {items.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No items</p>
        ) : (
          items
        )}
      </div>
    </div>
  );
}

function ActionQueue({ title, icon: Icon, items }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 mb-4">
        <Icon className="w-5 h-5" />
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-center text-slate-400 py-8">No items in queue</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
              <div>
                <div className="font-semibold text-slate-900">{item.name || item.customerName}</div>
                {item.time && <div className="text-xs text-slate-500">{item.time}</div>}
                {item.phone && <div className="text-xs text-slate-500">{item.phone}</div>}
              </div>
              {item.amount && <div className="text-sm font-bold text-red-600">${item.amount.toLocaleString()}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}