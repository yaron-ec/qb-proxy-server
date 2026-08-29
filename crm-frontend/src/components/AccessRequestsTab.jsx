import { useState, useEffect } from 'react';
import * as railwayApi from '@/lib/railwayApi';
import { apiCall } from '@/api/railway/client';
import { Check, X, Clock } from 'lucide-react';

export default function AccessRequestsTab() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(null);

  useEffect(() => {
    loadRequests();
  }, []);

  const loadRequests = async () => {
    try {
      const r = await apiCall('/api/v1/access-requests?status=pending', { method: 'GET' });
      const data = r.items || [];
      setRequests(data.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)));
    } catch (e) {
      console.error('Failed to load requests:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (id, email, fullName) => {
    if (!confirm(`Approve access for ${fullName}?`)) return;
    
    setProcessing(id);
    try {
      const meResp = await railwayApi.me();
      const userEmail = meResp.user?.email || 'admin';
      
      // Update request status
      await apiCall(`/api/v1/access-requests/${id}`, {
        method: 'PUT',
        body: {
          status: 'approved',
          reviewed_by: userEmail,
          reviewed_at: new Date().toISOString(),
        },
      });

      // Add to allowlist
      await apiCall('/api/v1/user-allowlist', {
        method: 'POST',
        body: {
          email: email.toLowerCase(),
          name: fullName,
          role: 'sales_rep',
          enabled: true,
        },
      });

      setRequests(requests.filter(r => r.id !== id));
    } catch (e) {
      alert('Error approving request: ' + e.message);
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (id, fullName) => {
    const notes = prompt(`Reject access for ${fullName}?\n\nOptional notes:`);
    if (notes === null) return;

    setProcessing(id);
    try {
      const meResp = await railwayApi.me();
      const userEmail = meResp.user?.email || 'admin';
      
      await apiCall(`/api/v1/access-requests/${id}`, {
        method: 'PUT',
        body: {
          status: 'rejected',
          reviewed_by: userEmail,
          reviewed_at: new Date().toISOString(),
          notes: notes.trim() || 'Rejected',
        },
      });

      setRequests(requests.filter(r => r.id !== id));
    } catch (e) {
      alert('Error rejecting request: ' + e.message);
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return <div className="p-6 text-slate-500">Loading requests...</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-slate-900">
          Pending Access Requests
        </h3>
        {requests.length > 0 && (
          <span className="bg-amber-100 text-amber-800 text-xs font-semibold px-3 py-1 rounded-full">
            {requests.length} pending
          </span>
        )}
      </div>

      {requests.length === 0 ? (
        <div className="card-premium p-8 text-center text-slate-400">
          <Clock className="w-8 h-8 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No pending access requests</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => (
            <div key={req.id} className="card-premium p-4 border-l-4 border-l-amber-500">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{req.full_name}</p>
                  <p className="text-xs text-slate-600 mt-1">{req.email}</p>
                  
                  {req.reason && (
                    <div className="mt-3 p-2 bg-slate-50 rounded border border-slate-200">
                      <p className="text-xs font-semibold text-slate-600 mb-1">Reason:</p>
                      <p className="text-xs text-slate-700">{req.reason}</p>
                    </div>
                  )}
                  
                  <p className="text-[10px] text-slate-400 mt-3">
                    Requested {new Date(req.created_date).toLocaleDateString()} at {new Date(req.created_date).toLocaleTimeString()}
                  </p>
                </div>

                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleApprove(req.id, req.email, req.full_name)}
                    disabled={processing === req.id}
                    className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <Check className="w-3.5 h-3.5" /> Approve
                  </button>
                  <button
                    onClick={() => handleReject(req.id, req.full_name)}
                    disabled={processing === req.id}
                    className="px-3 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <X className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}