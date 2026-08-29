/**
 * QBDiagnosticsPanel
 * Shows live QB connection diagnostics: environment, realm ID, company, email, OAuth status.
 * Also explains exactly how to switch from Sandbox to Production.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, AlertTriangle, CheckCircle, Info } from "lucide-react";

export default function QBDiagnosticsPanel({ qbStatus, company, isSandbox, isConnected }) {
  const [expanded, setExpanded] = useState(true);

  const env = qbStatus?.environment || '—';
  const realmId = qbStatus?.realm_id || '—';
  const connectedAt = qbStatus?.connected_at ? new Date(qbStatus.connected_at).toLocaleString() : '—';
  const tokenExpires = qbStatus?.token_expires_at ? new Date(qbStatus.token_expires_at).toLocaleString() : '—';
  const refreshExpires = qbStatus?.refresh_expires_at ? new Date(qbStatus.refresh_expires_at).toLocaleString() : '—';
  const companyName = company?.CompanyName || '—';
  const legalName = company?.LegalName || '—';
  const email = company?.CustomerCommunicationEmailAddr?.Address || company?.Email?.Address || '—';

  // Realm ID heuristic: Intuit sandbox realm IDs tend to be very long (18+ digits).
  // Production realm IDs are typically 13-16 digits.
  const realmIdNum = realmId.replace(/\D/g, '');
  const realmLooksLikeProduction = realmIdNum.length >= 13 && realmIdNum.length <= 16;
  const realmLooksLikeSandbox = realmIdNum.length > 16;
  const realmEnvironmentHint = !isConnected ? null
    : realmLooksLikeSandbox ? '(looks like a Sandbox realm ID — 18+ digits)'
    : realmLooksLikeProduction ? '(looks like a Production realm ID — 13–16 digits)'
    : null;

  const envMismatch = isConnected && isSandbox && realmLooksLikeProduction;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200 hover:bg-slate-100 transition-colors"
      >
        <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-500" />
          QuickBooks Connection Diagnostics
          {isConnected && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ml-1 ${isSandbox ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {isSandbox ? '⚠ SANDBOX' : '✓ PRODUCTION'}
            </span>
          )}
        </h3>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {expanded && (
        <div className="p-5 space-y-5">

          {/* ── LIVE STATUS TABLE ── */}
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Live Connection Status</p>
            <div className="bg-slate-900 rounded-lg p-4 font-mono text-xs space-y-1.5">
              <DiagRow label="OAuth Status" value={isConnected ? '✓ Connected' : '✗ Not connected'} color={isConnected ? 'text-emerald-400' : 'text-red-400'} />
              <DiagRow label="Environment (proxy QB_ENVIRONMENT)" value={env.toUpperCase()} color={isSandbox ? 'text-red-400' : 'text-emerald-400'} />
              <DiagRow label="Realm / Company ID" value={realmId} color="text-white" hint={realmEnvironmentHint} />
              <DiagRow label="Company Name" value={companyName} color="text-white" />
              <DiagRow label="Legal Name" value={legalName} color="text-white" />
              <DiagRow label="QB Account Email" value={email} color="text-white" />
              <DiagRow label="Connected At" value={connectedAt} color="text-slate-300" />
              <DiagRow label="Access Token Expires" value={tokenExpires} color="text-slate-300" />
              <DiagRow label="Refresh Token Expires" value={refreshExpires} color="text-slate-300" />
            </div>
          </div>

          {/* ── ENVIRONMENT MISMATCH WARNING ── */}
          {envMismatch && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-bold mb-1">⚠ Environment Mismatch Detected</p>
                <p>Your proxy is configured as <strong>SANDBOX</strong> but Realm ID <code className="bg-amber-100 px-1 rounded">{realmId}</code> appears to be a <strong>Production</strong> realm ID (13–16 digits). Sandbox realm IDs from Intuit are typically 18+ digits.</p>
                <p className="mt-1">This means your proxy is routing API calls to the sandbox API endpoint even though you authenticated with a production account. Data will not sync correctly.</p>
              </div>
            </div>
          )}

          {/* ── HOW TO SWITCH TO PRODUCTION ── */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
            <p className="text-sm font-bold text-blue-800 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" /> How to Switch from Sandbox → Production
            </p>
            <ol className="text-xs text-blue-900 space-y-2 list-none">
              <Step n={1} title="Change QB_ENVIRONMENT on your Railway proxy server">
                Go to your <strong>Railway dashboard</strong> → select the proxy service → <strong>Variables</strong> tab.
                Change <code className="bg-blue-100 px-1 rounded">QB_ENVIRONMENT</code> from <code className="bg-red-100 text-red-800 px-1 rounded">sandbox</code> to <code className="bg-emerald-100 text-emerald-800 px-1 rounded">production</code>.
                Then <strong>redeploy</strong> the service (Railway may do this automatically on variable save).
              </Step>
              <Step n={2} title="Verify QB_CLIENT_ID and QB_CLIENT_SECRET are Production credentials">
                In the <a href="https://developer.intuit.com" target="_blank" rel="noreferrer" className="underline font-semibold">Intuit Developer Console</a>, make sure you are using the <strong>Production</strong> app's credentials (not the Sandbox app).
                The Production app has a different Client ID and Secret.
              </Step>
              <Step n={3} title="Disconnect the current (sandbox) connection">
                Click the <strong>Disconnect</strong> button on this page to clear the stored sandbox tokens from the proxy.
              </Step>
              <Step n={4} title="Reconnect to QuickBooks">
                Click <strong>"Connect QuickBooks"</strong>. The OAuth popup will now use the Production credentials.
                When Intuit asks you to log in, use your <strong>Production</strong> QuickBooks account (not the developer sandbox).
              </Step>
              <Step n={5} title="Verify the new Realm ID">
                After reconnecting, this panel will show the new Realm ID and company name.
                The environment should show <strong className="text-emerald-700">✓ PRODUCTION</strong>.
              </Step>
            </ol>
          </div>

          {/* ── IMPORTANT NOTE ABOUT REALM IDs ── */}
          <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs text-slate-600 space-y-1">
            <p className="font-bold text-slate-700">About Realm ID {realmId}</p>
            <p>
              Realm ID <code className="bg-slate-200 px-1 rounded font-mono">{realmId}</code> is a <strong>{realmLooksLikeProduction ? 'Production-length' : 'Sandbox-length'}</strong> identifier ({realmIdNum.length} digits).
              Intuit's sandbox realm IDs assigned to developer accounts are typically 18–20 digits long. Production company realm IDs are typically 13–16 digits.
              This ID <strong>{realmLooksLikeProduction ? 'appears to be a Production realm ID' : 'appears to be a Sandbox realm ID'}</strong>.
            </p>
            <p className="text-slate-500">
              The environment label (Sandbox/Production) comes entirely from the <code className="bg-slate-200 px-0.5 rounded">QB_ENVIRONMENT</code> variable on your proxy server — it is NOT derived from the realm ID itself. If your proxy says "sandbox" but you authenticated with a production account, the data will be wrong.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

function DiagRow({ label, value, color, hint }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-slate-400 min-w-[220px] flex-shrink-0">{label}:</span>
      <span className={`font-bold ${color}`}>{value}</span>
      {hint && <span className="text-slate-500 text-[10px]">{hint}</span>}
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full text-[10px] font-black flex items-center justify-center mt-0.5">{n}</span>
      <div>
        <p className="font-bold text-blue-900 mb-0.5">{title}</p>
        <p className="text-blue-800">{children}</p>
      </div>
    </li>
  );
}