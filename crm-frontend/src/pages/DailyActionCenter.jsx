import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import * as railwayLeads from '@/api/railway/leads';
import * as railwayDeals from '@/api/railway/deals';
import { Link } from 'react-router-dom';
import {
  Phone, Mail, Clock, AlertTriangle, FileSignature, DollarSign,
  ChevronRight, RefreshCw, CheckCircle2
} from 'lucide-react';

const LEAD_CUTOFF_DAYS = 90;
const ACTIVE_STATUSES = ['Appointment scheduled', 'Proposal Sent', 'Sold'];
const EXCLUDE_STATUSES = ['DNQ', 'Lost', 'No show'];
const FOLLOWUP_WINDOW_DAYS = 7;
const OVERDUE_THRESHOLD_DAYS = 30;

export default function DailyActionCenter() {
  const { user } = useAuth();
  const [leads, setLeads] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadActionData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadActionData = async () => {
    try {
      const me = user;

      let leadsData, dealsData;
      // Railway API handles owner-scoping server-side (no RLS $in issue)
      [leadsData, dealsData] = await Promise.all([
        railwayLeads.list({ sort: '-updated_date', limit: 2000 }),
        railwayDeals.list({ sort: '-updated_date', limit: 1000 }),
      ]);
      leadsData = leadsData.items || [];
      dealsData = dealsData.items || [];
      if (me?.role === 'sales_rep') {
        // Filter deals by leads the rep owns
        const repLeadIds = new Set(leadsData.map(l => l.id));
        dealsData = dealsData.filter(d => repLeadIds.has(d.lead_id) || d.assigned_rep === me.full_name || d.assigned_rep === me.email);
      }

      setLeads(leadsData);
      setDeals(dealsData);
    } catch (e) {
      console.error('Error loading action data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadActionData();
    setRefreshing(false);
  };

  // Filter to only actionable leads
  const actionableLeads = leads.filter(lead => {
    // Exclude QB orphan/unmatched import records
    const isUnknownName = lead.first_name?.toLowerCase().includes('unknown') || lead.last_name?.toLowerCase().includes('unknown');
    const isQBOrphan = lead.source === 'QB Import' && (!lead.assigned_rep || lead.assigned_rep.trim() === '');
    if (isUnknownName || isQBOrphan) {
      return false;
    }

    // Exclude old leads (legacy imports)
    const createdDate = new Date(lead.crm_created_date || lead.created_date);
    const daysSinceCreation = (Date.now() - createdDate) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation > LEAD_CUTOFF_DAYS && !ACTIVE_STATUSES.includes(lead.status)) {
      return false;
    }

    // Exclude specific statuses
    if (EXCLUDE_STATUSES.includes(lead.status)) {
      return false;
    }

    // Only include active or recently updated leads
    return ACTIVE_STATUSES.includes(lead.status) || lead.status === 'New' || lead.status === 'Appointment scheduled';
  });

  // Build actionable items
  const actions = [];

  // Today's follow-ups
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today);
  todayEnd.setDate(todayEnd.getDate() + 1);

  // Next 7 days
  const week = new Date(today);
  week.setDate(week.getDate() + 7);

  actionableLeads.forEach(lead => {
    if (lead.follow_up_date) {
      const fuDate = new Date(lead.follow_up_date);
      fuDate.setHours(0, 0, 0, 0);
      const daysFromToday = (fuDate - today) / (1000 * 60 * 60 * 24);

      // Today's follow-ups
      if (fuDate >= today && fuDate < todayEnd) {
        actions.push({
          type: 'followup_today',
          priority: 'high',
          category: 'Follow-Up',
          title: `Call/Meeting: ${lead.first_name} ${lead.last_name}`,
          description: lead.follow_up_type ? `${lead.follow_up_type} scheduled` : 'Follow-up due',
          leadId: lead.id,
          phone: lead.phone,
          email: lead.email,
          assignedRep: lead.assigned_rep,
          followUpTime: lead.follow_up_time,
        });
      }

      // Upcoming (next 7 days)
      if (fuDate > todayEnd && fuDate <= week) {
        actions.push({
          type: 'followup_upcoming',
          priority: 'medium',
          category: 'Upcoming',
          title: `${lead.first_name} ${lead.last_name}`,
          description: `Follow-up on ${fuDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          leadId: lead.id,
          phone: lead.phone,
          assignedRep: lead.assigned_rep,
        });
      }

      // Overdue (less than 30 days)
      if (daysFromToday < 0) {
        const daysOverdue = Math.ceil(Math.abs(daysFromToday));
        if (daysOverdue <= OVERDUE_THRESHOLD_DAYS) {
          actions.push({
            type: 'followup_overdue',
            priority: daysOverdue > 14 ? 'critical' : 'high',
            category: 'Overdue',
            title: `${lead.first_name} ${lead.last_name}`,
            description: `Follow-up overdue by ${daysOverdue} days`,
            leadId: lead.id,
            phone: lead.phone,
            assignedRep: lead.assigned_rep,
            daysOverdue,
          });
        }
      }
    }

    // Missing owner
    if (!lead.assigned_rep || lead.assigned_rep.trim() === '') {
      actions.push({
        type: 'missing_owner',
        priority: 'high',
        category: 'Assignment',
        title: `${lead.first_name} ${lead.last_name}`,
        description: 'Lead has no assigned owner',
        leadId: lead.id,
      });
    }

    // Proposal sent but no response (>5 days)
    if (lead.status === 'Proposal Sent') {
      actions.push({
        type: 'proposal_waiting',
        priority: 'medium',
        category: 'Estimate',
        title: `${lead.first_name} ${lead.last_name}`,
        description: 'Awaiting response on proposal',
        leadId: lead.id,
      });
    }
  });

  // Deal-based actions
  deals.forEach(deal => {
    if (deal.lead_id && !actionableLeads.find(l => l.id === deal.lead_id)) return; // Skip deals for non-actionable leads

    // Missing invoice on sold deals
    if (deal.stage === 'Sold / Estimate Approved' && deal.final_payment_amount && !deal.final_payment_paid) {
      actions.push({
        type: 'invoice_missing',
        priority: 'high',
        category: 'Payment',
        title: deal.name,
        description: `Invoice missing for $${(deal.final_payment_amount || 0).toLocaleString()}`,
        dealId: deal.id,
        amount: deal.final_payment_amount,
      });
    }

    // Contract not signed
    if (deal.stage === 'Sold / Estimate Approved') {
      actions.push({
        type: 'contract_waiting',
        priority: 'medium',
        category: 'Contract',
        title: deal.name,
        description: 'Awaiting contract signature',
        dealId: deal.id,
      });
    }
  });

  // Calculate KPIs
  const todaysFollowUps = actions.filter(a => a.type === 'followup_today').length;
  const todaysAppointments = actionableLeads.filter(l => l.appointment_date && l.appointment_date === today.toISOString().split('T')[0]).length;
  const contractsWaiting = actions.filter(a => a.type === 'contract_waiting').length;
  const estimatesWaiting = actions.filter(a => a.type === 'proposal_waiting').length;
  const invoicesWaiting = actions.filter(a => a.type === 'invoice_missing').length;
  const newLeads = actionableLeads.filter(l => {
    const created = new Date(l.crm_created_date || l.created_date);
    return (Date.now() - created) / (1000 * 60 * 60 * 24) <= 7;
  }).length;

  const filteredActions = filter === 'all'
    ? actions
    : actions.filter(a => {
        if (filter === 'today') return a.type === 'followup_today';
        if (filter === 'overdue') return a.type === 'followup_overdue';
        if (filter === 'upcoming') return a.type === 'followup_upcoming';
        if (filter === 'critical') return ['missing_owner', 'followup_overdue', 'invoice_missing'].includes(a.type);
        return true;
      });

  if (loading) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Today's Actions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {filteredActions.length} actionable item{filteredActions.length !== 1 ? 's' : ''} • Focus on what matters today
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Actionable KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KPICard label="Today's Calls" value={todaysFollowUps} color="blue" icon={Phone} />
          <KPICard label="Appointments" value={todaysAppointments} color="green" icon={Clock} />
          <KPICard label="Contracts Waiting" value={contractsWaiting} color="purple" icon={FileSignature} />
          <KPICard label="Estimates Awaiting" value={estimatesWaiting} color="amber" icon={DollarSign} />
          <KPICard label="Invoices Due" value={invoicesWaiting} color="red" icon={AlertTriangle} />
          <KPICard label="New Leads (7d)" value={newLeads} color="slate" icon={CheckCircle2} />
        </div>

        {/* Filter Bar */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {[
            { id: 'all', label: 'All', count: filteredActions.length },
            { id: 'today', label: 'Today', count: actions.filter(a => a.type === 'followup_today').length },
            { id: 'overdue', label: 'Overdue', count: actions.filter(a => a.type === 'followup_overdue').length, color: 'red' },
            { id: 'upcoming', label: 'Upcoming', count: actions.filter(a => a.type === 'followup_upcoming').length },
            { id: 'critical', label: 'Critical', count: actions.filter(a => ['missing_owner', 'invoice_missing'].includes(a.type)).length, color: 'red' },
          ].map(btn => (
            <button
              key={btn.id}
              onClick={() => setFilter(btn.id)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg transition-all ${
                filter === btn.id
                  ? btn.id === 'all'
                    ? 'bg-slate-900 text-white'
                    : `bg-${btn.color || 'amber'}-100 text-${btn.color || 'amber'}-700 border border-${btn.color || 'amber'}-300`
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {btn.label} {btn.count > 0 && <span className="ml-1 font-bold">({btn.count})</span>}
            </button>
          ))}
        </div>

        {/* Actions List */}
        <div className="space-y-2">
          {filteredActions.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">All caught up! No actionable items.</p>
            </div>
          ) : (
            filteredActions.map((action, idx) => (
              <ActionItem key={idx} action={action} />
            ))
          )}
        </div>

      </div>
    </div>
  );
}

function KPICard({ label, value, color, icon: Icon }) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-600 border-blue-200',
    green: 'bg-green-50 text-green-600 border-green-200',
    red: 'bg-red-50 text-red-600 border-red-200',
    orange: 'bg-orange-50 text-orange-600 border-orange-200',
    amber: 'bg-amber-50 text-amber-600 border-amber-200',
    purple: 'bg-purple-50 text-purple-600 border-purple-200',
    slate: 'bg-slate-50 text-slate-600 border-slate-200',
  };

  return (
    <div className={`border rounded-lg p-3 ${colorClasses[color]}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium opacity-75">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
        <Icon className="w-5 h-5 opacity-50 flex-shrink-0" />
      </div>
    </div>
  );
}

function ActionItem({ action }) {
  const priorityColors = {
    critical: 'bg-red-50 border-red-300 border-l-4 border-l-red-600 shadow-sm',
    high: 'bg-orange-50 border-orange-200 border-l-4 border-l-orange-600',
    medium: 'bg-amber-50 border-amber-200 border-l-4 border-l-amber-500',
    low: 'bg-slate-50 border-slate-200 border-l-4 border-l-slate-400',
  };

  const priorityBadgeColors = {
    critical: 'bg-red-100 text-red-700',
    high: 'bg-orange-100 text-orange-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-slate-100 text-slate-700',
  };

  const getActionLink = () => {
    if (action.leadId) return `/leads/${action.leadId}`;
    if (action.dealId) return `/deals/${action.dealId}`;
    return null;
  };

  const actionLink = getActionLink();
  const content = (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${priorityBadgeColors[action.priority]}`}>
            {action.priority.toUpperCase()}
          </span>
          <span className="text-xs font-medium text-slate-500">{action.category}</span>
        </div>
        <h3 className="text-sm font-bold text-slate-900 mb-1">{action.title}</h3>
        <p className="text-xs text-slate-600 mb-2">{action.description}</p>

        {/* Action-specific details */}
        <div className="flex flex-wrap gap-3 text-xs">
          {action.assignedRep && (
            <span className="text-slate-500">👤 {action.assignedRep}</span>
          )}
          {action.phone && (
            <a href={`tel:${action.phone}`} className="text-green-600 hover:underline flex items-center gap-1">
              <Phone className="w-3 h-3" /> {action.phone}
            </a>
          )}
          {action.email && (
            <a href={`mailto:${action.email}`} className="text-blue-600 hover:underline flex items-center gap-1">
              <Mail className="w-3 h-3" /> {action.email}
            </a>
          )}
          {action.followUpTime && (
            <span className="text-slate-500">⏰ {action.followUpTime}</span>
          )}
          {action.amount && (
            <span className="text-slate-700 font-semibold">${action.amount.toLocaleString()}</span>
          )}
          {action.daysOverdue && (
            <span className="text-red-600 font-bold">{action.daysOverdue} days overdue</span>
          )}
        </div>
      </div>

      {actionLink && (
        <ChevronRight className="w-5 h-5 text-slate-300 flex-shrink-0" />
      )}
    </div>
  );

  if (actionLink) {
    return (
      <Link to={actionLink} className={`block p-4 rounded-lg border ${priorityColors[action.priority]} hover:shadow-md transition-all`}>
        {content}
      </Link>
    );
  }

  return (
    <div className={`p-4 rounded-lg border ${priorityColors[action.priority]}`}>
      {content}
    </div>
  );
}