import { useState } from 'react';
import { apiCall } from '@/api/railway/client';
import { Mail, AlertCircle, CheckCircle } from 'lucide-react';

export default function AccessRequestForm({ userEmail }) {
  const [fullName, setFullName] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!fullName.trim()) {
      setError('Please enter your full name');
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      await apiCall('/api/v1/access-requests', {
        method: 'POST',
        body: {
          email: userEmail.toLowerCase(),
          name: fullName.trim(),
          status: 'pending',
          reason: reason.trim(),
        },
      });

      // Notification email is sent server-side when the access request is created
      
      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-8 text-center max-w-md mx-auto mt-12">
        <CheckCircle className="w-12 h-12 text-emerald-600 mx-auto mb-4" />
        <h2 className="text-lg font-bold text-slate-900 mb-2">Request submitted</h2>
        <p className="text-sm text-slate-600 mb-4">
          You'll be notified by email if your request is approved.
        </p>
        <p className="text-xs text-slate-500">
          Logged in as: <span className="font-semibold">{userEmail}</span>
        </p>
        <button
          onClick={() => window.location.href = '/'}
          className="mt-6 px-4 py-2 bg-slate-100 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-200 transition-colors"
        >
          Return home
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-8 max-w-md mx-auto mt-12">
      <div className="flex justify-center mb-6">
        <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
          <Mail className="w-6 h-6 text-blue-600" />
        </div>
      </div>
      
      <h2 className="text-xl font-bold text-slate-900 text-center mb-2">Request access</h2>
      <p className="text-sm text-slate-600 text-center mb-6">
        Your email is not yet authorized. Submit a request and an administrator will review it.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-slate-700 block mb-2">Email</label>
          <input
            type="email"
            value={userEmail}
            disabled
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-700 block mb-2">Full Name *</label>
          <input
            type="text"
            placeholder="John Doe"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            value={fullName}
            onChange={e => setFullName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-700 block mb-2">Why do you need access?</label>
          <textarea
            placeholder="I'm part of the sales team..."
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none"
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
        </div>

        {error && (
          <div className="flex gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {loading ? 'Submitting...' : 'Submit request'}
        </button>
      </form>

      <p className="text-xs text-slate-500 text-center mt-6">
        An administrator will review your request shortly.
      </p>
    </div>
  );
}