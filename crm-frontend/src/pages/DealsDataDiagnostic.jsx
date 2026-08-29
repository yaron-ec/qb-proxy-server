import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { AlertCircle, CheckCircle, AlertTriangle, RefreshCw } from "lucide-react";

export default function DealsDataDiagnostic() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const runDiagnostic = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiCall('/api/v1/leads', { method: 'GET' });
      setData(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runDiagnostic();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-slate-600">Running data diagnostic...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="bg-red-50 border border-red-300 rounded-lg p-6">
            <div className="flex gap-3">
              <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-bold text-red-900 mb-2">Error</h2>
                <p className="text-red-700 font-mono text-sm mb-4">{error}</p>
                <button
                  onClick={runDiagnostic}
                  className="px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700 transition-colors inline-flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" /> Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const hasIssues = Object.values(data.diagnostic_summary).some(issue => issue !== 'OK');

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Deals Data Diagnostic</h1>
          <p className="text-sm text-slate-500 mt-1">{data.timestamp}</p>
        </div>

        {/* User Info */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4">User Authentication</h2>
          <div className="space-y-2 font-mono text-sm">
            <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
              <span className="text-slate-600">Email:</span>
              <span className="text-slate-900 font-semibold">{data.user.email}</span>
            </div>
            <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
              <span className="text-slate-600">User.role:</span>
              <span className="text-slate-900 font-semibold">{data.user.role}</span>
            </div>
            <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
              <span className="text-slate-600">Hardcoded isAdmin:</span>
              <span className={`font-semibold ${data.user.isAdmin ? 'text-emerald-700' : 'text-red-700'}`}>
                {data.user.isAdmin ? 'YES' : 'NO'}
              </span>
            </div>
            {data.user.isAdminRoleMismatch === 'YES - ISSUE' && (
              <div className="mt-3 p-3 bg-red-100 border border-red-300 rounded">
                <div className="text-red-900 font-bold text-sm">⚠️ CRITICAL: User has admin role but not in hardcoded ADMIN_USERS list</div>
              </div>
            )}
          </div>
        </div>

        {/* Sold Leads Query */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4">Sold Leads Query</h2>
          <div className="bg-slate-50 p-3 rounded border border-slate-200 mb-4">
            <code className="text-xs text-slate-600">Lead.filter({"{ status: \"Sold\" }"})</code>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-emerald-50 p-4 rounded border border-emerald-200">
                <div className="text-xs font-semibold text-emerald-900">Total Sold Leads</div>
                <div className="text-3xl font-bold text-emerald-700 mt-1">{data.sold_leads_query.total_count}</div>
              </div>
              <div className="bg-blue-50 p-4 rounded border border-blue-200">
                <div className="text-xs font-semibold text-blue-900">Total Revenue</div>
                <div className="text-3xl font-bold text-blue-700 mt-1">{data.sold_leads_query.revenue_formatting.formatted}</div>
              </div>
            </div>

            {data.sold_leads_query.first_10.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">First 10 Sold Leads</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left py-2 px-3 font-semibold text-slate-600">#</th>
                        <th className="text-left py-2 px-3 font-semibold text-slate-600">ID</th>
                        <th className="text-left py-2 px-3 font-semibold text-slate-600">Name</th>
                        <th className="text-right py-2 px-3 font-semibold text-slate-600">Value</th>
                        <th className="text-left py-2 px-3 font-semibold text-slate-600">Created</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.sold_leads_query.first_10.map(lead => (
                        <tr key={lead.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 text-slate-600">{lead.rank}</td>
                          <td className="py-2 px-3 text-xs text-slate-500 font-mono">{lead.id.slice(0, 8)}</td>
                          <td className="py-2 px-3 text-slate-900 font-medium">{lead.name}</td>
                          <td className="py-2 px-3 text-right text-slate-900 font-semibold">
                            ${lead.estimated_value.toLocaleString()}
                          </td>
                          <td className="py-2 px-3 text-xs text-slate-500">
                            {new Date(lead.created_date).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* All Statuses */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4">All Lead Statuses in Database</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(data.all_statuses_in_db.counts_by_status)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => (
                <div key={status} className={`p-3 rounded border ${
                  status === 'Sold' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
                }`}>
                  <div className={`text-sm font-semibold ${status === 'Sold' ? 'text-emerald-900' : 'text-slate-600'}`}>
                    {status}
                  </div>
                  <div className={`text-2xl font-bold mt-1 ${status === 'Sold' ? 'text-emerald-700' : 'text-slate-700'}`}>
                    {count}
                  </div>
                </div>
              ))}
          </div>
          <div className="mt-4 text-sm text-slate-600">
            Total leads in database: <span className="font-bold">{data.all_statuses_in_db.total_leads}</span>
          </div>
        </div>

        {/* Expected Values */}
        <div className={`rounded-lg p-6 border-2 ${
          hasIssues ? 'bg-red-50 border-red-300' : 'bg-green-50 border-green-300'
        }`}>
          <h2 className="text-lg font-bold mb-4">
            {hasIssues ? (
              <span className="flex items-center gap-2 text-red-900">
                <AlertCircle className="w-5 h-5" /> Issues Found
              </span>
            ) : (
              <span className="flex items-center gap-2 text-green-900">
                <CheckCircle className="w-5 h-5" /> All Data Consistent
              </span>
            )}
          </h2>

          <div className="space-y-2 text-sm">
            {Object.entries(data.diagnostic_summary).map(([key, status]) => (
              <div key={key} className="flex items-start gap-2">
                {status === 'OK' ? (
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <span className={status === 'OK' ? 'text-green-900' : 'text-red-900'}>
                  {status}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-slate-200 space-y-1 text-sm font-mono">
            <div><span className="text-slate-600">Deals should show:</span> <span className="font-bold text-slate-900">{data.expected_values.deals_count_should_be} deals</span></div>
            <div><span className="text-slate-600">Revenue should be:</span> <span className="font-bold text-slate-900">{data.expected_values.deals_revenue_formatted_should_be}</span></div>
          </div>
        </div>

        <button
          onClick={runDiagnostic}
          className="px-6 py-2 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-colors inline-flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" /> Re-run Diagnostic
        </button>
      </div>
    </div>
  );
}