import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { Link } from 'react-router-dom';
import { Phone, Mail, Calendar, FileCheck, TrendingUp, DollarSign, AlertTriangle, Clock } from 'lucide-react';

export default function RepDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const currentUser = await apiCall('/api/v1/auth/me', { method: 'GET' }).catch(() => null);
      setUser(currentUser);
      if (!currentUser) return;

      const [leads, deals, documents, invoices] = await Promise.all([
        apiCall('/api/v1/leads?limit=500', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])),
        apiCall('/api/v1/deals?limit=500', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])),
        apiCall('/api/v1/signnow/documents?limit=500', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])).catch(() => []),
        apiCall('/api/v1/invoices?limit=500', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])),
      ]);

      // Filter to current user's leads
      const userEmail = currentUser.email;
      const myLeads = leads.filter(l =>
        l.assigned_rep?.toLowerCase().includes(userEmail.split('@')[0].toLowerCase()) ||
        l.assigned_rep?.toLowerCase() === userEmail
      );

      const myDeals = deals.filter(d => myLeads.some(l => l.id === d.lead_id));
      const myDocuments = documents.filter(d => myLeads.some(l => l.id === d.lead_id));
      const myInvoices = invoices.filter(i => myLeads.some(l => l.id === i.lead_id));

      const today = new Date().toISOString().split('T')[0];

      // Calculate metrics
      const callsToday = myLeads.filter(l =>
        l.follow_up_date === today && l.follow_up_type === 'Phone Call'
      );

      const myFollowUps = myLeads.filter(l =>
        l.follow_up_date && l.follow_up_date >= today && !['Sold', 'Lost', 'DNQ'].includes(l.status)
      );

      const myAppointments = myLeads.filter(l =>
        l.appointment_date && new Date(l.appointment_date) >= new Date()
      );

      const contractsWaiting = myDocuments.filter(d =>
        ['sent', 'viewed'].includes(d.status)
      );

      const atRiskDeals = myDeals.filter(d => {
        const daysSinceUpdate = Math.floor((new Date() - new Date(d.updated_date || d.created_date)) / (1000 * 60 * 60 * 24));
        return daysSinceUpdate > 14;
      });

      const revenuePipeline = myDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
      const revenueCollected = myInvoices
        .filter(i => i.payment_status === 'paid')
        .reduce((sum, i) => sum + (i.payment_received || 0), 0);

      setData({
        leads: myLeads,
        deals: myDeals,
        callsToday,
        followUps: myFollowUps,
        appointments: myAppointments,
        contractsWaiting,
        atRiskDeals,
        revenuePipeline,
        revenueCollected,
      });
    } catch (e) {
      console.error('Error loading rep data:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div></div>;
  }

  if (!data) return <div className="p-6 text-center text-slate-400">Failed to load dashboard</div>;

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">My Sales Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">{user?.full_name} • {user?.email}</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <KPICard icon={Phone} label="Calls Today" value={data.callsToday.length} color="green" />
          <KPICard icon={Clock} label="Follow-Ups" value={data.followUps.length} color="blue" />
          <KPICard icon={Calendar} label="Appointments" value={data.appointments.length} color="purple" />
          <KPICard icon={FileCheck} label="Contracts Waiting" value={data.contractsWaiting.length} color="orange" />
        </div>

        {/* Revenue KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-slate-500">REVENUE PIPELINE</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">${(data.revenuePipeline / 1000).toFixed(0)}K</p>
              </div>
              <DollarSign className="w-8 h-8 text-blue-100" />
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-slate-500">COLLECTED</p>
                <p className="text-2xl font-bold text-emerald-600 mt-1">${(data.revenueCollected / 1000).toFixed(0)}K</p>
              </div>
              <TrendingUp className="w-8 h-8 text-emerald-100" />
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-slate-500">TOTAL LEADS</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{data.leads.length}</p>
              </div>
              <AlertTriangle className="w-8 h-8 text-amber-100" />
            </div>
          </div>
        </div>

        {/* Sections */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Calls Today */}
          <Section title={`☎️ Calls Today (${data.callsToday.length})`} color="green">
            {data.callsToday.length === 0 ? (
              <p className="text-sm text-slate-400">No calls scheduled today</p>
            ) : (
              data.callsToday.map(lead => (
                <Link
                  key={lead.id}
                  to={`/leads/${lead.id}`}
                  className="block p-3 bg-green-50 border border-green-200 rounded-lg hover:shadow-md transition-all mb-2"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold text-slate-900">{lead.first_name} {lead.last_name}</p>
                      <p className="text-xs text-slate-600">Time: {lead.follow_up_time || '—'}</p>
                    </div>
                    <Phone className="w-4 h-4 text-green-600" />
                  </div>
                </Link>
              ))
            )}
          </Section>

          {/* Follow-Ups This Week */}
          <Section title={`Follow-Ups (${data.followUps.length})`} color="blue">
            {data.followUps.slice(0, 5).map(lead => (
              <Link
                key={lead.id}
                to={`/leads/${lead.id}`}
                className="block p-3 bg-blue-50 border border-blue-200 rounded-lg hover:shadow-md transition-all mb-2"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">{lead.first_name} {lead.last_name}</p>
                    <p className="text-xs text-slate-600">{lead.follow_up_date} • {lead.follow_up_type}</p>
                  </div>
                  <Clock className="w-4 h-4 text-blue-600" />
                </div>
              </Link>
            ))}
            {data.followUps.length > 5 && (
              <p className="text-xs text-slate-500 text-center py-2">+{data.followUps.length - 5} more</p>
            )}
          </Section>

          {/* Appointments */}
          <Section title={`📅 Appointments (${data.appointments.length})`} color="purple">
            {data.appointments.slice(0, 5).map(lead => (
              <Link
                key={lead.id}
                to={`/leads/${lead.id}`}
                className="block p-3 bg-purple-50 border border-purple-200 rounded-lg hover:shadow-md transition-all mb-2"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">{lead.first_name} {lead.last_name}</p>
                    <p className="text-xs text-slate-600">{lead.appointment_date} at {lead.appointment_time || '—'}</p>
                  </div>
                  <Calendar className="w-4 h-4 text-purple-600" />
                </div>
              </Link>
            ))}
            {data.appointments.length > 5 && (
              <p className="text-xs text-slate-500 text-center py-2">+{data.appointments.length - 5} more</p>
            )}
          </Section>

          {/* Contracts Waiting */}
          <Section title={`📋 Contracts Awaiting (${data.contractsWaiting.length})`} color="orange">
            {data.contractsWaiting.length === 0 ? (
              <p className="text-sm text-slate-400">No contracts waiting</p>
            ) : (
              data.contractsWaiting.map(doc => (
                <div key={doc.id} className="p-3 bg-orange-50 border border-orange-200 rounded-lg mb-2">
                  <p className="font-semibold text-slate-900">{doc.document_name}</p>
                  <p className="text-xs text-slate-600">{doc.signer_name || 'Awaiting signature'}</p>
                  <p className="text-xs text-orange-600 font-semibold mt-1">{doc.status === 'sent' ? 'Sent' : 'Viewed'}</p>
                </div>
              ))
            )}
          </Section>

          {/* At-Risk Deals */}
          <Section title={`⚠️ At-Risk Deals (${data.atRiskDeals.length})`} color="red">
            {data.atRiskDeals.length === 0 ? (
              <p className="text-sm text-slate-400">All deals on track</p>
            ) : (
              data.atRiskDeals.slice(0, 5).map(deal => (
                <Link
                  key={deal.id}
                  to={`/deals/${deal.id}`}
                  className="block p-3 bg-red-50 border border-red-200 rounded-lg hover:shadow-md transition-all mb-2"
                >
                  <p className="font-semibold text-slate-900">{deal.name}</p>
                  <p className="text-xs text-slate-600">{deal.stage} • ${(deal.amount / 1000).toFixed(0)}K</p>
                </Link>
              ))
            )}
          </Section>

        </div>

      </div>
    </div>
  );
}

function KPICard({ icon: Icon, label, value, color }) {
  const colors = {
    green: 'bg-green-50 text-green-600 border-green-200',
    blue: 'bg-blue-50 text-blue-600 border-blue-200',
    purple: 'bg-purple-50 text-purple-600 border-purple-200',
    orange: 'bg-orange-50 text-orange-600 border-orange-200',
  };

  return (
    <div className={`border rounded-lg p-4 ${colors[color]}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium opacity-75">{label}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
        </div>
        <Icon className="w-6 h-6 opacity-50" />
      </div>
    </div>
  );
}

function Section({ title, color, children }) {
  const bgColor = {
    green: 'bg-green-50 border-green-200',
    blue: 'bg-blue-50 border-blue-200',
    purple: 'bg-purple-50 border-purple-200',
    orange: 'bg-orange-50 border-orange-200',
    red: 'bg-red-50 border-red-200',
  }[color];

  return (
    <div className={`border ${bgColor} rounded-lg p-5`}>
      <h2 className="font-bold text-slate-900 mb-4">{title}</h2>
      {children}
    </div>
  );
}