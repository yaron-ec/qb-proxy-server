import { useState } from 'react';
import { apiCall } from '@/api/railway/client';
import { AlertCircle, Zap, CheckCircle } from 'lucide-react';

export default function LeadQualificationTab() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleCleanup = async () => {
    if (!confirm(
      'This will move non-qualified records to Contacts.\n\n' +
      'Records without Lead Status, Appointment, Follow-up, Project Type, Deal, Estimate, Owner, Source, or Activity will be moved.\n\n' +
      'Continue?'
    )) return;

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await apiCall('/api/v1/admin/move-non-leads-to-contacts', { method: 'POST' });
      setResult(res);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-900 mb-2">Lead Qualification</h3>
        <p className="text-sm text-slate-600">
          Separate qualified leads from pure contacts. A record qualifies as a Lead if it has:
        </p>
        <ul className="text-sm text-slate-600 mt-3 space-y-1 ml-4 list-disc">
          <li>Lead Status</li>
          <li>Appointment Date</li>
          <li>Follow-up Date</li>
          <li>Project Type</li>
          <li>Deal</li>
          <li>Estimate</li>
          <li>Assigned Owner</li>
          <li>Lead Source</li>
          <li>Sales Activity</li>
        </ul>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex gap-3">
          <AlertCircle className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-semibold mb-1">Move Non-Leads to Contacts</p>
            <p className="text-amber-700 mb-3">
              Records without any lead qualification will be moved to the Contacts section and hidden from Active Leads.
            </p>
            <button
              onClick={handleCleanup}
              disabled={running}
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <Zap className="w-4 h-4" />
              {running ? 'Running...' : 'Run Cleanup Now'}
            </button>
          </div>
        </div>
      </div>

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
          <div className="flex gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-900">
              <p className="font-semibold mb-2">Cleanup Complete</p>
              <div className="space-y-1 text-emerald-800">
                <p>Total Leads: <strong>{result.total_leads}</strong></p>
                <p>Non-Qualified Found: <strong>{result.non_qualified_found}</strong></p>
                <p>Moved to Contacts: <strong>{result.moved_to_contacts}</strong></p>
                {result.errors > 0 && <p className="text-red-600">Errors: {result.errors}</p>}
              </div>
              {result.details.length > 0 && (
                <div className="mt-3 text-xs">
                  <p className="font-semibold mb-1">Sample moved:</p>
                  <ul className="space-y-1">
                    {result.details.map((d, i) => (
                      <li key={i}>• {d.name} {d.email ? `(${d.email})` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm font-semibold text-red-900">Error: {error}</p>
        </div>
      )}
    </div>
  );
}