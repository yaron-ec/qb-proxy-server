import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { DollarSign, TrendingUp, AlertCircle, CheckCircle, Clock, RefreshCw, Zap } from 'lucide-react';
import { SPINNER, CARD_PADDED } from '@/lib/design-system';

export default function QBExecutiveDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadMetrics();
  }, []);

  const loadMetrics = async () => {
    setLoading(true);
    setError(null);
    try {
      setError('QB Executive Metrics not yet ported to Railway API');
    } catch (e) {
      setError(e.message || 'Error loading metrics');
    }
    setLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      // QB sync not yet ported to Railway API
      setTimeout(loadMetrics, 2000);
    } catch (e) {
      setError('Sync failed: ' + e.message);
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className={SPINNER} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-background p-6">
        <div className="max-w-md bg-card rounded-xl border border-red-200 p-6 text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
          <h2 className="text-sm font-bold text-slate-900 mb-2">Error Loading Dashboard</h2>
          <p className="text-xs text-slate-600 mb-4">{error}</p>
          <button onClick={loadMetrics} className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { revenue, customers, repMetrics, syncStatus, automationHooks } = data;

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">QB Executive Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {syncStatus.connected ? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 bg-green-500 rounded-full" />
                    Connected to {syncStatus.environment}
                  </span>
                  {syncStatus.lastFullSync && (
                    <span className="text-xs text-muted-foreground ml-3">
                      Last synced {new Date(syncStatus.lastFullSync).toLocaleString()}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-red-600">QB Connection Failed</span>
              )}
            </p>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>

        {/* Revenue Overview */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-4">Executive Revenue Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard label="Total Revenue" value={fmtMoney(revenue.totalInvoiced)} icon={DollarSign} color="emerald" />
            <KPICard label="Revenue Collected" value={fmtMoney(revenue.totalCollected)} icon={CheckCircle} color="blue" />
            <KPICard label="Outstanding" value={fmtMoney(revenue.outstanding)} icon={AlertCircle} color="amber" />
            <KPICard label="This Month" value={fmtMoney(revenue.thisMonth)} icon={TrendingUp} color="violet" />
            <KPICard label="This Year" value={fmtMoney(revenue.thisYear)} icon={TrendingUp} color="slate" />
            <KPICard label="Open Invoices" value={revenue.openInvoiceCount.toString()} icon={Clock} color="slate" />
            <KPICard label="Overdue" value={revenue.overdueInvoiceCount.toString()} icon={AlertCircle} color="red" />
            <KPICard label="Avg Invoice" value={fmtMoney(revenue.avgInvoiceValue)} icon={DollarSign} color="slate" />
          </div>
        </div>

        {/* Revenue by Sales Rep */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-4">Revenue by Sales Rep ({repMetrics.length} reps)</h2>
          <div className={CARD_PADDED}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Rep</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Total Sold</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Collected</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Open</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Customers</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Avg Deal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {repMetrics.map((rep, i) => (
                    <tr key={rep.rep} className="hover:bg-secondary/50 transition-colors">
                      <td className="py-3 px-4 text-sm font-semibold text-foreground">
                        <span className="inline-flex items-center">
                          <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold mr-2">
                            {i + 1}
                          </span>
                          {rep.rep}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm font-bold text-emerald-600 text-right">{fmtMoney(rep.totalRevenue)}</td>
                      <td className="py-3 px-4 text-sm text-blue-600 text-right">{fmtMoney(rep.totalCollected)}</td>
                      <td className="py-3 px-4 text-sm text-amber-600 text-right">{fmtMoney(rep.openBalance)}</td>
                      <td className="py-3 px-4 text-sm text-slate-600 text-right">{rep.customerCount}</td>
                      <td className="py-3 px-4 text-sm text-slate-600 text-right font-semibold">{fmtMoney(rep.avgDealSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Customer Financial Status */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-4">Customer Financial Status ({customers.length} customers)</h2>
          <div className={CARD_PADDED}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Customer</th>
                    <th className="text-left py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Rep</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Total Invoiced</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Collected</th>
                    <th className="text-right py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Open Balance</th>
                    <th className="text-center py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Status</th>
                    <th className="text-center py-3 px-4 text-xs font-bold text-muted-foreground uppercase">Last Invoice</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {customers.map(cust => (
                    <tr key={cust.id} className="hover:bg-secondary/50 transition-colors">
                      <td className="py-3 px-4 font-semibold text-foreground">
                        {cust.name}
                        {cust.leadStatus && cust.leadStatus !== 'Sold' && (
                          <span className="ml-2 text-xs font-normal text-amber-600">({cust.leadStatus})</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{cust.assignedRep}</td>
                      <td className="py-3 px-4 text-right text-emerald-600 font-semibold">{fmtMoney(cust.totalInvoiced)}</td>
                      <td className="py-3 px-4 text-right text-blue-600 font-semibold">{fmtMoney(cust.totalPaid)}</td>
                      <td className="py-3 px-4 text-right font-bold" style={{ color: cust.openBalance > 0 ? '#dc2626' : '#059669' }}>
                        {fmtMoney(cust.openBalance)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                          cust.status === 'Paid' ? 'bg-emerald-100 text-emerald-700' :
                          cust.status === 'Overdue' ? 'bg-red-100 text-red-700' :
                          cust.status === 'Partial' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {cust.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center text-xs text-muted-foreground">
                        {cust.lastInvoiceDate ? new Date(cust.lastInvoiceDate).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Sync Monitoring */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-4">Sync Monitoring</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Activity */}
            <div className={CARD_PADDED}>
              <h3 className="text-sm font-bold text-foreground mb-4">Recent Sync Activity</h3>
              <div className="space-y-2">
                {syncStatus.recentActivity.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent activity</p>
                ) : (
                  syncStatus.recentActivity.map(activity => (
                    <div key={activity.id} className="flex items-start gap-3 p-2 bg-secondary/30 rounded-lg text-xs">
                      {activity.status === 'success' ? (
                        <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-foreground">{activity.entityName}</div>
                        <div className="text-muted-foreground">{activity.action} - {activity.type}</div>
                        {activity.error && <div className="text-red-600 mt-1">{activity.error}</div>}
                      </div>
                      <div className="text-muted-foreground flex-shrink-0 whitespace-nowrap">
                        {new Date(activity.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Sync Errors */}
            <div className={CARD_PADDED}>
              <h3 className="text-sm font-bold text-foreground mb-4">Recent Errors</h3>
              {syncStatus.errors.length === 0 ? (
                <div className="flex items-center gap-2 p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                  <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <p className="text-sm font-semibold text-emerald-700">No sync errors</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {syncStatus.errors.map(err => (
                    <div key={err.id} className="p-3 bg-red-50 rounded-lg border border-red-200">
                      <div className="text-xs font-bold text-red-700 mb-1">{err.entity_name}</div>
                      <div className="text-xs text-red-600">{err.error_message}</div>
                      <div className="text-xs text-red-400 mt-1">{new Date(err.created_date).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Automation Readiness */}
        <div>
          <h2 className="text-lg font-bold text-foreground mb-4">Automation Readiness</h2>
          <div className={CARD_PADDED}>
            <p className="text-xs text-muted-foreground mb-4">
              These automations are ready to activate when integration credits reset on June 30.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.entries(automationHooks).map(([key, hook]) => (
                <div key={key} className="p-4 rounded-lg border border-border bg-secondary/30">
                  <div className="flex items-start gap-2 mb-2">
                    <Zap className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-foreground">{formatHookName(key)}</div>
                      <div className="text-xs text-muted-foreground mt-1">{hook.description}</div>
                      <span className="text-xs font-semibold text-amber-600 mt-2 inline-block">Ready</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KPICard({ label, value, icon: Icon, color }) {
  const colorMap = {
    emerald: { bg: 'bg-emerald-50', icon: 'text-emerald-600', text: 'text-emerald-700' },
    blue: { bg: 'bg-blue-50', icon: 'text-blue-600', text: 'text-blue-700' },
    amber: { bg: 'bg-amber-50', icon: 'text-amber-600', text: 'text-amber-700' },
    violet: { bg: 'bg-violet-50', icon: 'text-violet-600', text: 'text-violet-700' },
    red: { bg: 'bg-red-50', icon: 'text-red-600', text: 'text-red-700' },
    slate: { bg: 'bg-slate-50', icon: 'text-slate-600', text: 'text-slate-700' },
  };

  const c = colorMap[color];
  return (
    <div className={`${c.bg} border border-border rounded-lg p-4`}>
      <div className="flex items-center gap-3 mb-2">
        <Icon className={`w-5 h-5 ${c.icon} flex-shrink-0`} />
        <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{label}</div>
      </div>
      <div className={`text-2xl font-bold ${c.text}`}>{value}</div>
    </div>
  );
}

function fmtMoney(n) {
  if (!n) return '$0';
  return '$' + (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : Math.round(n).toLocaleString());
}

function formatHookName(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim();
}