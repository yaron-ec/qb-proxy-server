/**
 * QBEnvironmentSelector
 * 
 * Shows the ACTUAL environment from the proxy server (QB_ENVIRONMENT on Railway).
 * The CRM has no control over the environment — it's set server-side on the proxy.
 * This component is purely informational + helps diagnose the connection state.
 */
import { useState, useEffect } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { AlertTriangle, CheckCircle, Loader2, RefreshCw, ExternalLink } from "lucide-react";

export default function QBEnvironmentSelector() {
  const [proxyHealth, setProxyHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadProxyHealth();
  }, []);

  const loadProxyHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call qbAuth status which hits the proxy and returns environment info
      const res = await railwayRequest('/qb/auth-status', {});
      setProxyHealth(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const env = proxyHealth?.environment || null;
  const isProduction = env?.toLowerCase() === 'production';
  const isSandbox = env?.toLowerCase() === 'sandbox';
  const isConnected = proxyHealth?.connected;
  const realmId = proxyHealth?.realm_id;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-800">QuickBooks Environment</h3>
        <button onClick={loadProxyHealth} disabled={loading} className="text-slate-400 hover:text-slate-600 transition-colors">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {loading && !proxyHealth && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking proxy environment...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-700 mb-3">
          <strong>Could not reach proxy:</strong> {error}
        </div>
      )}

      {proxyHealth && (
        <div className="space-y-3">
          {/* Environment Status */}
          <div className={`rounded-lg border-2 p-4 ${isProduction ? 'border-emerald-400 bg-emerald-50' : isSandbox ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center gap-3">
              {isProduction ? (
                <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
              ) : isSandbox ? (
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
              ) : (
                <div className="w-5 h-5 border-2 border-slate-300 rounded-full flex-shrink-0" />
              )}
              <div>
                <div className={`font-bold text-sm ${isProduction ? 'text-emerald-800' : isSandbox ? 'text-red-800' : 'text-slate-700'}`}>
                  {isProduction ? '✓ Production (Live)' : isSandbox ? '⚠ Sandbox (Testing)' : `Environment: ${env || 'Unknown'}`}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Set via <code className="bg-white px-1 rounded border border-slate-200">QB_ENVIRONMENT</code> on Railway proxy
                </div>
              </div>
            </div>

            {realmId && isConnected && (
              <div className="mt-2 font-mono text-xs text-slate-600 bg-white rounded px-2 py-1 border border-slate-200">
                Realm ID: {realmId}
              </div>
            )}
          </div>

          {/* If sandbox, explain how to fix */}
          {isSandbox && (
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 space-y-1.5">
              <p className="font-bold">To switch to Production:</p>
              <ol className="list-decimal ml-4 space-y-1">
                <li>Go to your <a href="https://railway.app" target="_blank" rel="noreferrer" className="underline font-semibold inline-flex items-center gap-0.5">Railway dashboard <ExternalLink className="w-2.5 h-2.5" /></a></li>
                <li>Open the <strong>adaptable-cooperation</strong> service → Variables</li>
                <li>Change <code className="bg-amber-100 px-0.5 rounded">QB_ENVIRONMENT</code> from <code className="bg-red-100 text-red-800 px-0.5 rounded">sandbox</code> to <code className="bg-emerald-100 text-emerald-800 px-0.5 rounded">production</code></li>
                <li>Railway will redeploy automatically</li>
                <li>Come back here and click <strong>Disconnect</strong>, then <strong>Connect QuickBooks</strong></li>
              </ol>
            </div>
          )}

          {/* If production but not connected */}
          {isProduction && !isConnected && (
            <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-xs text-emerald-800">
              <p className="font-bold">✓ Proxy is configured for Production.</p>
              <p className="mt-0.5">Click <strong>"Connect QuickBooks"</strong> above to authenticate with your live QuickBooks account.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}