import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { AlertCircle, CheckCircle, AlertTriangle, RefreshCw } from "lucide-react";

export default function PermissionDiagnostics() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const runDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiCall('/api/v1/leads', { method: 'GET' });
      setDiagnostics(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runDiagnostics();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-slate-600">Running permission diagnostics...</p>
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
                <h2 className="text-lg font-bold text-red-900 mb-2">Error Running Diagnostics</h2>
                <p className="text-red-700 font-mono text-sm mb-4">{error}</p>
                <button
                  onClick={runDiagnostics}
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

  if (!diagnostics) {
    return null;
  }

  const getSeverity = (issue) => {
    if (issue.includes('CRITICAL')) return 'critical';
    if (issue.includes('WARNING')) return 'warning';
    return 'ok';
  };

  const severity = getSeverity(diagnostics.summary.permission_issue);

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Permission Model Diagnostics</h1>
          <p className="text-sm text-slate-500 mt-1">Run at {diagnostics.timestamp}</p>
        </div>

        {/* Overall Status */}
        <div className={`rounded-lg p-6 border-2 ${
          severity === 'critical' ? 'bg-red-50 border-red-300' :
          severity === 'warning' ? 'bg-yellow-50 border-yellow-300' :
          'bg-green-50 border-green-300'
        }`}>
          <div className="flex gap-3 items-start">
            {severity === 'critical' && <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />}
            {severity === 'warning' && <AlertTriangle className="w-6 h-6 text-yellow-600 flex-shrink-0 mt-0.5" />}
            {severity === 'ok' && <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />}
            <div className="flex-1">
              <h2 className={`text-lg font-bold mb-2 ${
                severity === 'critical' ? 'text-red-900' :
                severity === 'warning' ? 'text-yellow-900' :
                'text-green-900'
              }`}>
                {diagnostics.summary.permission_issue}
              </h2>
              <p className={`text-sm ${
                severity === 'critical' ? 'text-red-700' :
                severity === 'warning' ? 'text-yellow-700' :
                'text-green-700'
              }`}>
                {diagnostics.summary.root_cause_hypothesis}
              </p>
            </div>
          </div>
        </div>

        {/* Section: Authentication */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Layer 1: Authentication</h3>
          <div className="space-y-2 font-mono text-sm">
            <div className="flex justify-between py-1">
              <span className="text-slate-600">Email:</span>
              <span className="text-slate-900 font-semibold">{diagnostics.authentication.email}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-600">Full Name:</span>
              <span className="text-slate-900">{diagnostics.authentication.full_name}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-600">User.role (from User entity):</span>
              <span className={`font-semibold ${diagnostics.authentication.role_from_user_entity === 'admin' ? 'text-emerald-700' : 'text-slate-900'}`}>
                {diagnostics.authentication.role_from_user_entity}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-600">User ID:</span>
              <span className="text-slate-900 text-xs">{diagnostics.authentication.id}</span>
            </div>
          </div>
        </div>

        {/* Section: Allowlist */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Layer 2: Allowlist (UserAllowlist Entity)</h3>
          {diagnostics.allowlist.found ? (
            <div className="space-y-2 font-mono text-sm">
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Status:</span>
                <span className="text-emerald-700 font-bold">✓ Found in allowlist</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Email:</span>
                <span className="text-slate-900">{diagnostics.allowlist.entry.email}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Name:</span>
                <span className="text-slate-900">{diagnostics.allowlist.entry.name}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Allowlist Role:</span>
                <span className={`font-semibold ${diagnostics.allowlist.entry.role === 'admin' ? 'text-emerald-700' : 'text-slate-900'}`}>
                  {diagnostics.allowlist.entry.role}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Enabled:</span>
                <span className={diagnostics.allowlist.entry.enabled ? 'text-emerald-700 font-bold' : 'text-red-700'}>
                  {diagnostics.allowlist.entry.enabled ? 'Yes' : 'NO'}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-red-700 font-semibold">✗ NOT found in allowlist</div>
          )}
        </div>

        {/* Section: Admin Status */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Layer 3: Admin Status Calculation</h3>
          <div className="space-y-3">
            <div className="bg-slate-50 p-3 rounded border border-slate-200">
              <div className="text-xs font-semibold text-slate-600 mb-2">Hardcoded Admin List:</div>
              <div className="font-mono text-sm text-slate-900 space-y-1">
                {diagnostics.admin_status.hardcoded_admin_list.map((email, i) => (
                  <div key={i} className={`py-0.5 ${email === diagnostics.authentication.email ? 'bg-emerald-100 px-2 rounded font-bold text-emerald-900' : ''}`}>
                    {email}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 font-mono text-sm">
              <div className="flex justify-between py-1 bg-slate-50 px-3 py-2 rounded">
                <span className="text-slate-600">User.role === 'admin':</span>
                <span className={diagnostics.admin_status.user_role_is_admin ? 'text-emerald-700 font-bold' : 'text-slate-900'}>
                  {diagnostics.admin_status.user_role_is_admin ? 'YES ✓' : 'NO'}
                </span>
              </div>
              <div className="flex justify-between py-1 bg-slate-50 px-3 py-2 rounded">
                <span className="text-slate-600">In hardcoded admin list:</span>
                <span className={diagnostics.admin_status.is_in_hardcoded_admin_list ? 'text-emerald-700 font-bold' : 'text-red-700 font-bold'}>
                  {diagnostics.admin_status.is_in_hardcoded_admin_list ? 'YES ✓' : 'NO ✗'}
                </span>
              </div>

              {diagnostics.admin_status.role_mismatch !== 'OK' && (
                <div className="mt-3 p-3 bg-red-100 border border-red-300 rounded">
                  <div className="text-red-900 font-bold text-sm">{diagnostics.admin_status.role_mismatch}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section: Owner Mapping */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Layer 4: Owner Mapping</h3>
          <div className="space-y-3">
            <div className="bg-slate-50 p-3 rounded border border-slate-200">
              <div className="text-xs font-semibold text-slate-600 mb-2">Hardcoded User → Owner Map:</div>
              <div className="font-mono text-sm text-slate-900 space-y-1">
                {Object.entries(diagnostics.owner_mapping.hardcoded_map).map(([email, owner], i) => (
                  <div key={i} className={`py-0.5 ${email === diagnostics.authentication.email ? 'bg-emerald-100 px-2 rounded font-bold text-emerald-900' : ''}`}>
                    {email} → {owner}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 font-mono text-sm">
              <div className="flex justify-between py-1 bg-slate-50 px-3 py-2 rounded">
                <span className="text-slate-600">Your mapped owner name:</span>
                <span className="text-slate-900 font-semibold">{diagnostics.owner_mapping.hardcoded_mapped_to || '—'}</span>
              </div>
            </div>

            {Object.keys(diagnostics.owner_mapping.settings_owner_emails).length > 0 && (
              <div className="bg-blue-50 p-3 rounded border border-blue-200">
                <div className="text-xs font-semibold text-blue-900 mb-2">Owner Email Mapping (from Settings):</div>
                <div className="font-mono text-sm text-blue-900 space-y-1">
                  {Object.entries(diagnostics.owner_mapping.settings_owner_emails).map(([owner, email], i) => (
                    <div key={i}>{owner}: {email}</div>
                  ))}
                </div>
              </div>
            )}

            {diagnostics.owner_mapping.available_contact_owners.length > 0 && (
              <div className="bg-purple-50 p-3 rounded border border-purple-200">
                <div className="text-xs font-semibold text-purple-900 mb-2">Available Contact Owners:</div>
                <div className="font-mono text-sm text-purple-900 space-y-1">
                  {diagnostics.owner_mapping.available_contact_owners.map((owner, i) => (
                    <div key={i} className={diagnostics.owner_mapping.hardcoded_mapped_to === owner ? 'bg-purple-200 px-2 py-1 rounded font-bold' : ''}>
                      {owner}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Section: RLS Test */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Layer 5: RLS / Record Visibility</h3>
          <div className="space-y-2 font-mono text-sm">
            <div className="flex justify-between py-1 bg-slate-50 px-3 py-2 rounded">
              <span className="text-slate-600">Can read leads:</span>
              <span className={diagnostics.rls_test.able_to_read_leads === 'YES' ? 'text-emerald-700 font-bold' : 'text-red-700 font-bold'}>
                {diagnostics.rls_test.able_to_read_leads}
              </span>
            </div>

            {diagnostics.rls_test.sample_lead && (
              <div className="bg-emerald-50 p-3 rounded border border-emerald-200 mt-3">
                <div className="text-xs font-bold text-emerald-900 mb-2">Sample Lead (first record):</div>
                <div className="space-y-1 text-slate-900">
                  <div>Name: {diagnostics.rls_test.sample_lead.name}</div>
                  <div>Assigned Rep: {diagnostics.rls_test.sample_lead.assigned_rep || '—'}</div>
                  <div>ID: <span className="text-xs">{diagnostics.rls_test.sample_lead.id}</span></div>
                </div>
              </div>
            )}

            {diagnostics.rls_test.read_error && (
              <div className="bg-red-50 p-3 rounded border border-red-200 mt-3">
                <div className="text-red-900 font-bold text-sm">Read Error:</div>
                <div className="text-red-700 text-xs font-mono mt-1">{diagnostics.rls_test.read_error}</div>
              </div>
            )}
          </div>
        </div>

        {/* Button */}
        <div className="flex gap-3">
          <button
            onClick={runDiagnostics}
            className="px-6 py-2 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-colors inline-flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> Re-run Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
}