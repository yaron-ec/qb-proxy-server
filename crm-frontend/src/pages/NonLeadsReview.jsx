import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { Check, X, AlertCircle } from 'lucide-react';
import { toTitleCase } from '@/lib/formatters';

const NON_LEAD_PATTERNS = [
  'Designer', 'Candidate', 'Warehouse', 'Roofing Company', 
  'Flooring Company', 'Inc', 'LLC', 'Contractor', 'Services'
];

export default function NonLeadsReview() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [recordType, setRecordType] = useState('Contact');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSuspiciousLeads();
  }, []);

  const loadSuspiciousLeads = async () => {
    try {
      const res = await apiCall('/api/v1/leads?limit=2000', { method: 'GET' });
      const allLeads = Array.isArray(res) ? res : (res?.items || []);
      const suspicious = allLeads.filter(lead => {
        const fullName = `${lead.first_name || ''} ${lead.last_name || ''}`;
        return NON_LEAD_PATTERNS.some(pattern => fullName.includes(pattern));
      });
      setLeads(suspicious);
      setLoading(false);
    } catch (e) {
      console.error('Error loading suspicious leads:', e);
      setLoading(false);
    }
  };

  const toggleSelect = (leadId) => {
    const newSelected = new Set(selected);
    if (newSelected.has(leadId)) {
      newSelected.delete(leadId);
    } else {
      newSelected.add(leadId);
    }
    setSelected(newSelected);
  };

  const toggleSelectAll = () => {
    if (selected.size === leads.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(leads.map(l => l.id)));
    }
  };

  const saveChanges = async () => {
    setSaving(true);
    let updated = 0;
    for (const leadId of selected) {
      try {
        await apiCall(`/api/v1/leads/${leadId}`, { method: 'PUT', body: { record_type: recordType } });
        updated++;
      } catch (e) {
        console.error(`Error updating lead ${leadId}:`, e);
      }
    }
    setSaving(false);
    setSelected(new Set());
    await loadSuspiciousLeads();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <h1 className="text-2xl font-bold text-slate-900">Non-Leads Review</h1>
          <p className="text-sm text-slate-500 mt-0.5">Records matching vendor/employee patterns ({leads.length})</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {leads.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <AlertCircle className="w-8 h-8 mx-auto mb-2" />
            <p>No suspicious records found</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={selected.size === leads.length && leads.length > 0}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 accent-amber-600"
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {leads.map(lead => (
                    <tr key={lead.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(lead.id)}
                          onChange={() => toggleSelect(lead.id)}
                          className="w-4 h-4 accent-amber-600"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-slate-900">
                        {toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500">{lead.email || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{lead.status || 'New'}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{lead.record_type || 'Lead'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selected.size > 0 && (
              <div className="mt-6 bg-white rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="text-sm font-semibold text-slate-700">
                    {selected.size} selected
                  </div>
                  <div className="flex items-center gap-3">
                    <select
                      value={recordType}
                      onChange={e => setRecordType(e.target.value)}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                    >
                      <option value="Contact">Contact</option>
                      <option value="Vendor">Vendor</option>
                      <option value="Employee">Employee</option>
                      <option value="Job Applicant">Job Applicant</option>
                    </select>
                    <button
                      onClick={saveChanges}
                      disabled={saving}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" />
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}