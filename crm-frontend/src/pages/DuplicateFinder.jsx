import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { ArrowLeft, AlertCircle, GitMerge, Loader2 } from "lucide-react";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import { findPotentialDuplicates } from "@/lib/duplicateDetection";

export default function DuplicateFinder() {
  const [leads, setLeads] = useState([]);
  const [duplicates, setDuplicates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(null);
  const [mergeResult, setMergeResult] = useState(null);

  useEffect(() => {
    loadAndAnalyze();
  }, []);

  const loadAndAnalyze = async () => {
    setLoading(true);
    try {
      const res = await apiCall('/api/v1/leads?limit=5000', { method: 'GET' });
      const allLeads = Array.isArray(res) ? res : (res?.items || []);
      // Filter out DNQ, Contacts, and non-Lead records
      const activeLeads = allLeads.filter(
        l => l.status !== 'DNQ' && l.record_type !== 'Contact' && !l.is_contact
      );
      setLeads(activeLeads);
      
      const potentialDupes = findPotentialDuplicates(activeLeads);
      setDuplicates(potentialDupes);
    } catch (e) {
      console.error('Error loading duplicates:', e);
    }
    setLoading(false);
  };

  const handleMerge = async (leadA, leadB) => {
    setMerging(`${leadA.id}|${leadB.id}`);
    try {
      // Merge endpoint not yet ported to Railway API
      setMergeResult({ message: 'Merge not yet ported to Railway API', activities_moved: 0, tasks_moved: 0, estimates_moved: 0, deals_moved: 0 });
      // Reload after merge
      setTimeout(() => {
        loadAndAnalyze();
        setMerging(null);
      }, 1500);
    } catch (e) {
      console.error('Merge error:', e);
      setMerging(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-amber-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-4">
          <Link to="/settings" className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800">
            <ArrowLeft className="w-4 h-4" />
            Settings
          </Link>
          <div className="w-px h-4 bg-slate-200"></div>
          <h1 className="text-lg font-bold text-slate-900">Find & Merge Duplicates</h1>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {mergeResult && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-6">
            <p className="text-sm font-semibold text-emerald-800">{mergeResult.message}</p>
            <p className="text-xs text-emerald-700 mt-1">
              Moved: {mergeResult.activities_moved} activities, {mergeResult.tasks_moved} tasks, 
              {mergeResult.estimates_moved} estimates, {mergeResult.deals_moved} deals
            </p>
          </div>
        )}

        {duplicates.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 p-12 text-center">
            <div className="w-12 h-12 bg-emerald-50 rounded-lg flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="w-6 h-6 text-emerald-600" />
            </div>
            <p className="text-lg font-semibold text-slate-900 mb-1">No Duplicates Found</p>
            <p className="text-sm text-slate-500">Your lead database is clean!</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              <p className="text-sm font-semibold text-amber-900">
                Found {duplicates.length} potential duplicate pair{duplicates.length !== 1 ? 's' : ''}
              </p>
            </div>

            {duplicates.map((dup, idx) => (
              <DuplicatePair
                key={idx}
                leadA={dup.leadA}
                leadB={dup.leadB}
                matchType={dup.matchType}
                confidence={dup.confidence}
                onMerge={() => handleMerge(dup.leadA, dup.leadB)}
                isMerging={merging === `${dup.leadA.id}|${dup.leadB.id}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DuplicatePair({ leadA, leadB, matchType, confidence, onMerge, isMerging }) {
  const confidenceColor = confidence > 0.95 ? 'text-red-600' : confidence > 0.85 ? 'text-amber-600' : 'text-yellow-600';
  const matchLabel = {
    phone_match: 'Phone Match',
    email_match: 'Email Match',
    name_phone_match: 'Name + Phone',
    name_email_match: 'Name + Email',
    name_city_match: 'Name + City',
    name_address_match: 'Name + Address',
  }[matchType] || matchType;

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="grid grid-cols-2 gap-6 p-6">
        {/* Lead A */}
        <LeadPreview lead={leadA} />
        
        {/* Lead B */}
        <LeadPreview lead={leadB} />

        {/* Merge Button */}
        <div className="col-span-2 flex items-center justify-between bg-slate-50 px-4 py-3 border-t border-slate-200">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${confidenceColor}`}>
              {matchLabel} • {Math.round(confidence * 100)}% match
            </span>
          </div>
          <button
            onClick={onMerge}
            disabled={isMerging}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isMerging ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="w-4 h-4" />
                Merge
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadPreview({ lead }) {
  return (
    <div className="space-y-3">
      <Link
        to={`/leads/${lead.id}`}
        className="text-sm font-bold text-amber-600 hover:text-amber-700 inline-flex items-center gap-1"
      >
        {toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}
        <span className="text-xs">→</span>
      </Link>
      
      <div className="space-y-2 text-sm">
        {lead.phone && (
          <div className="flex items-center gap-2">
            <span className="text-slate-600 font-semibold">Phone:</span>
            <span className="text-slate-800">{formatPhone(lead.phone)}</span>
          </div>
        )}
        {lead.email && (
          <div className="flex items-center gap-2">
            <span className="text-slate-600 font-semibold">Email:</span>
            <span className="text-slate-800 truncate">{lead.email}</span>
          </div>
        )}
        {lead.city && (
          <div className="flex items-center gap-2">
            <span className="text-slate-600 font-semibold">City:</span>
            <span className="text-slate-800">{toTitleCase(lead.city)}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-semibold">Status:</span>
          <span className="text-xs font-semibold bg-amber-100 text-amber-900 px-2 py-1 rounded">
            {lead.status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-semibold">Owner:</span>
          <span className="text-slate-800">{toTitleCase(lead.assigned_rep) || '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600 font-semibold">Created:</span>
          <span className="text-slate-800 text-xs">
            {new Date(lead.crm_created_date || lead.created_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
      </div>
    </div>
  );
}