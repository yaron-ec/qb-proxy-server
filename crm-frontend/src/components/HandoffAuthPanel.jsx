import { useState, useEffect } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { Unlink, CheckCircle, AlertTriangle, Loader2, Eye, EyeOff, Copy, Check } from "lucide-react";

export default function HandoffAuthPanel({ onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [copiedTokenPreview, setCopiedTokenPreview] = useState(false);

  const checkStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await railwayRequest('/handoff/auth', { action: 'status' });
      setStatus(res);
      if (onStatusChange) onStatusChange(res);
    } catch (e) {
      setError(e.message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const handleStoreToken = async () => {
    if (!tokenInput.trim()) {
      setError('Bearer token cannot be empty');
      return;
    }

    setTokenizing(true);
    setError(null);
    try {
      const res = await railwayRequest('/handoff/auth', {
        action: 'store_token',
        token: tokenInput,
      });

      if (res?.success) {
        setTokenInput('');
        setShowForm(false);
        await checkStatus();
      } else {
        setError(res?.error || 'Failed to store token');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setTokenizing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Handoff? You will need to provide a new bearer token to sync again.')) return;
    setLoading(true);
    try {
      await railwayRequest('/handoff/auth', { action: 'disconnect' });
      setStatus(null);
      if (onStatusChange) onStatusChange(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex items-center gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        <span className="text-sm text-slate-500">Checking Handoff connection...</span>
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-emerald-900">Connected to Handoff</p>
              <p className="text-xs text-emerald-700 mt-1">
                Bearer token authenticated. Automatic hourly syncs are enabled.
                {status.connected_at && ` Connected ${new Date(status.connected_at).toLocaleDateString()}.`}
              </p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:text-red-700 border border-red-300 rounded px-3 py-1.5 hover:bg-red-50 transition-colors whitespace-nowrap"
          >
            <Unlink className="w-3.5 h-3.5" /> Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
      {!showForm ? (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-blue-900">Connect Handoff Bearer Token</p>
            <p className="text-xs text-blue-700 mt-1">
              Paste your bearer token from DevTools. It will be stored securely and used for automatic hourly syncs.
            </p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors whitespace-nowrap"
          >
            Add Token
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-blue-900 block mb-1.5">Bearer Token</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                className="w-full border border-blue-300 rounded-lg px-3 py-2 text-xs font-mono bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-100 border border-red-300 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <span className="text-xs font-semibold text-red-800">{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleStoreToken}
              disabled={tokenizing || !tokenInput.trim()}
              className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {tokenizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {tokenizing ? 'Verifying...' : 'Save Token'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setTokenInput('');
                setError(null);
              }}
              disabled={tokenizing}
              className="flex-1 border border-slate-300 text-slate-700 px-4 py-2 text-sm font-bold rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>

          <p className="text-[10px] text-blue-700 bg-blue-100 rounded px-2 py-1.5">
            💡 <strong>How to get your bearer token:</strong> Open Handoff in a browser, open DevTools (F12), go to Network tab, filter for "graphql", make any request, click it, scroll to Authorization header — copy the full "Bearer ..." value.
          </p>
        </div>
      )}
    </div>
  );
}