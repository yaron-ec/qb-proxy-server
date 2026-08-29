import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { TrendingUp, Target, Zap } from 'lucide-react';

export default function SalesRepScoreboard() {
  const [scoreboard, setScoreboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('revenueSold');

  useEffect(() => {
    loadScoreboard();
  }, []);

  const loadScoreboard = async () => {
    try {
      const res = await apiCall('/api/v1/leads', { method: 'GET' });
      setScoreboard(res?.scoreboard || []);
    } catch (e) {
      console.error('Error loading scoreboard:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div></div>;
  }

  const sorted = [...scoreboard].sort((a, b) => {
    if (sortBy === 'revenueSold') return b.revenueSold - a.revenueSold;
    if (sortBy === 'closeRate') return b.closeRate - a.closeRate;
    if (sortBy === 'leadsAssigned') return b.leadsAssigned - a.leadsAssigned;
    return 0;
  });

  const topPerformer = sorted[0];
  const totalRevenue = sorted.reduce((sum, r) => sum + r.revenueSold, 0);
  const avgCloseRate = Math.round(sorted.reduce((sum, r) => sum + r.closeRate, 0) / sorted.length) || 0;

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Sales Rep Scoreboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Performance metrics and leaderboard</p>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <StatCard
            icon={TrendingUp}
            label="Total Revenue Sold"
            value={`$${(totalRevenue / 1000).toFixed(0)}K`}
            color="emerald"
          />
          <StatCard
            icon={Target}
            label="Average Close Rate"
            value={`${avgCloseRate}%`}
            color="blue"
          />
          <StatCard
            icon={Zap}
            label="Top Performer"
            value={topPerformer?.name || '—'}
            subtitle={`$${(topPerformer?.revenueSold / 1000).toFixed(0)}K`}
            color="amber"
          />
        </div>

        {/* Sort Controls */}
        <div className="flex gap-2 mb-6">
          {[
            { value: 'revenueSold', label: 'Sort: Revenue Sold' },
            { value: 'closeRate', label: 'Sort: Close Rate' },
            { value: 'leadsAssigned', label: 'Sort: Leads Assigned' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                sortBy === opt.value
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Leaderboard */}
        <div className="space-y-3">
          {sorted.map((rep, index) => (
            <LeaderboardRow key={rep.name} rep={rep} rank={index + 1} total={sorted.length} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subtitle, color }) {
  const colorMap = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
  };

  return (
    <div className={`rounded-lg border p-6 ${colorMap[color]}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-sm font-medium opacity-75">{label}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {subtitle && <p className="text-xs opacity-75 mt-1">{subtitle}</p>}
        </div>
        <Icon className="w-6 h-6 opacity-50" />
      </div>
    </div>
  );
}

function LeaderboardRow({ rep, rank, total }) {
  const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '  ';
  const maxRevenue = Math.max(...Array.from({ length: total }, () => 0));

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start gap-4">
        {/* Rank Badge */}
        <div className="text-2xl font-bold text-slate-300 min-w-[2rem] text-center">
          {medalEmoji}
          <div className="text-sm text-slate-500">{rank}</div>
        </div>

        {/* Rep Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-slate-900 text-lg">{rep.name}</h3>

          {/* Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3 mt-3">
            <Metric label="Leads" value={rep.leadsAssigned} />
            <Metric label="Appts Set" value={rep.appointmentsSet} />
            <Metric label="Appts Held" value={rep.appointmentsHeld} />
            <Metric label="Contracts" value={rep.contractsSent} />
            <Metric label="Signed" value={rep.contractsSigned} />
            <Metric label="Close Rate" value={`${rep.closeRate}%`} accent />
            <Metric label="Revenue Sold" value={`$${rep.revenueSold >= 1000 ? (rep.revenueSold / 1000).toFixed(0) + 'K' : rep.revenueSold.toLocaleString()}`} accent />
            <Metric label="Collected" value={`$${rep.revenueCollected >= 1000 ? (rep.revenueCollected / 1000).toFixed(0) + 'K' : rep.revenueCollected.toLocaleString()}`} accent />
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div className={`text-center py-1 rounded ${accent ? 'bg-amber-50 border border-amber-100' : 'bg-slate-50'}`}>
      <div className={`text-sm font-bold ${accent ? 'text-amber-700' : 'text-slate-900'}`}>{value}</div>
      <div className="text-[11px] text-slate-500 font-medium">{label}</div>
    </div>
  );
}