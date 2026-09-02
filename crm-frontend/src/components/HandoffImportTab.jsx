import { useState, useEffect } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayHandoffEstimates from "@/api/railway/handoffEstimates";
import { apiCall } from "@/api/railway/client";
import { appParams } from "@/lib/app-params";
import { RAILWAY_API_URL } from "@/lib/apiConfig";
import {
  Zap, CheckCircle, Loader2, AlertTriangle, Upload, FileJson,
  Link, Copy, Check, Clock, ChevronDown, ChevronUp, Play, Wifi, WifiOff, RefreshCw, Database
} from "lucide-react";
import { SyncSection, SyncSectionHeader, SyncInfoNotice, SyncStatRow, SyncBtn, SyncStepList } from "./SyncCard";

function getWebhookUrl() {
  return `${RAILWAY_API_URL}/handoff/import-estimate`;
}

// ─── Webhook Setup ────────────────────────────────────────────────────────────
function WebhookSetupPanel() {
  const [copied, setCopied] = useState(false);
  const webhookUrl = getWebhookUrl();

  const handleCopy = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SyncSection>
      <SyncSectionHeader icon={Link} title="Webhook (Automatic Sync)" iconColor="text-blue-500"
        badge={{ label: "Recommended", className: "bg-blue-100 text-blue-700" }} />
      <p className="text-xs text-slate-500 mb-3">
        Configure this URL in your Handoff account under <strong className="text-slate-700">Settings → Webhooks</strong>.
        Handoff will push new estimates automatically whenever one is created or updated.
      </p>
      <div className="flex items-center gap-2 mb-3">
        <code className="flex-1 text-xs font-mono bg-slate-100 border border-slate-200 rounded px-3 py-2 text-slate-700 truncate">
          {webhookUrl}
        </code>
        <SyncBtn variant="blue" onClick={handleCopy} icon={copied ? Check : Copy}>
          {copied ? 'Copied!' : 'Copy'}
        </SyncBtn>
      </div>
      <SyncStepList variant="blue" steps={[
        'Log in to your Handoff account',
        'Go to Settings → Webhooks (or Notifications)',
        'Add a new webhook and paste the URL above',
        'Select events: estimate created, updated, approved, signed',
        'Save — future estimates will sync automatically',
      ]} />
    </SyncSection>
  );
}

// ─── CSV / JSON Import ────────────────────────────────────────────────────────
function CsvImportPanel() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [showPaste, setShowPaste] = useState(false);

  const parseRows = (text) => {
    text = text.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    const lines = text.split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
      return row;
    });
  };

  const mapRow = (row, idx) => {
    const name = row.customer_name || row.client_name || row.name || '';
    const email = row.customer_email || row.client_email || row.email || '';
    const phone = row.customer_phone || row.client_phone || row.phone || '';
    const amount = parseFloat(row.amount || row.total || row.estimate_amount || 0) || 0;
    const status = row.status || row.estimate_status || 'unknown';
    const id = String(row.id || row.estimate_id || `csv_import_${Date.now()}_${idx}`);
    const number = String(row.number || row.estimate_number || id);
    const rawDate = row.date || row.created_at || row.estimate_date || '';
    const date = rawDate ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (!name) return null;
    return { handoff_estimate_id: id, handoff_estimate_number: number, customer_name: name, customer_email: email, customer_phone: phone, estimate_amount: amount, estimate_status: status, estimate_date: date, last_synced_at: new Date().toISOString(), source: 'Handoff', sync_source: 'Handoff', match_status: 'unmatched', match_method: 'none' };
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setJsonText(ev.target.result); setShowPaste(true); };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!jsonText.trim()) return;
    setImporting(true);
    setResult(null);
    let rows;
    try { rows = parseRows(jsonText); } catch (e) {
      setResult({ success: false, error: `Parse error: ${e.message}` });
      setImporting(false);
      return;
    }
    let leads = [];
    try {     leads = await railwayLeads.list({ sort: '-created_date', limit: 5000 }).then(r => r.items || []); } catch (e) {}
    const normPhone = (p) => (p || '').replace(/\D/g, '').slice(-10);
    const normEmail = (e) => (e || '').toLowerCase().trim();
    const normName = (n) => (n || '').toLowerCase().trim().replace(/\s+/g, ' ');
    let imported = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const record = mapRow(rows[i], i);
      if (!record) { skipped++; continue; }
      const em = normEmail(record.customer_email);
      const ph = normPhone(record.customer_phone);
      const nm = normName(record.customer_name);
      for (const lead of leads) {
        const lEm = normEmail(lead.email);
        const lPh = normPhone(lead.phone);
        const lNm = normName(`${lead.first_name || ''} ${lead.last_name || ''}`);
        if (em && lEm && em === lEm) { record.lead_id = lead.id; record.match_status = 'matched'; break; }
        if (ph && lPh && ph === lPh) { record.lead_id = lead.id; record.match_status = 'matched'; break; }
        if (nm && lNm && nm === lNm) { record.lead_id = lead.id; record.match_status = 'matched'; break; }
      }
      try {
        const existing = await apiCall(`/api/v1/handoff-estimates?handoff_estimate_id=${encodeURIComponent(record.handoff_estimate_id)}`, { method: 'GET' }).then(r => r.items || []);
        if (existing.length > 0) { await railwayHandoffEstimates.update(existing[0].id, record); updated++; }
        else { await railwayHandoffEstimates.create(record); imported++; }
      } catch (e) { failed++; errors.push(`${record.customer_name}: ${e.message}`); }
    }
    setResult({ success: true, total: rows.length, imported, updated, skipped, failed, errors });
    setImporting(false);
  };

  return (
    <SyncSection>
      <SyncSectionHeader icon={Upload} title="CSV / JSON Import" iconColor="text-amber-500" />
      <p className="text-xs text-slate-500 mb-3">
        Export your estimates from Handoff as CSV or JSON and import them here.
        Records are matched automatically by email, phone, or name.
      </p>

      <div className="space-y-3">
        <label className="flex items-center gap-3 border-2 border-dashed border-slate-200 rounded-lg px-4 py-3 cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition-colors">
          <FileJson className="w-4 h-4 text-slate-400" />
          <div>
            <p className="text-xs font-semibold text-slate-700">Upload CSV or JSON</p>
            <p className="text-[10px] text-slate-400">Supports .csv, .json, .txt</p>
          </div>
          <input type="file" accept=".csv,.json,.txt" className="hidden" onChange={handleFileUpload} />
        </label>

        <button onClick={() => setShowPaste(!showPaste)}
          className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 font-semibold transition-colors">
          {showPaste ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Or paste data manually
        </button>

        {showPaste && (
          <textarea value={jsonText} onChange={e => setJsonText(e.target.value)}
            placeholder={`Paste CSV or JSON here...\n\nCSV: customer_name,customer_email,amount,status\nJSON: [{"customer_name":"John","amount":15000}]`}
            className="w-full h-32 text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 text-slate-800 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        )}

        {jsonText.trim() && (
          <SyncBtn onClick={handleImport} disabled={importing} loading={importing} icon={Zap}>
            {importing ? 'Importing...' : 'Import Data'}
          </SyncBtn>
        )}
      </div>

      {result && (
        result.success ? (
          <div className="mt-3">
            <SyncInfoNotice variant="green">
              <div className="flex items-center gap-2 font-semibold mb-2"><CheckCircle className="w-3.5 h-3.5" /> Import complete</div>
              <SyncStatRow items={[
                { label: "Total", value: result.total, color: "slate" },
                { label: "Imported", value: result.imported, color: "green" },
                { label: "Updated", value: result.updated, color: "blue" },
                { label: "Skipped", value: result.skipped, color: "amber" },
                { label: "Failed", value: result.failed, color: result.failed > 0 ? "red" : "slate" },
              ]} />
            </SyncInfoNotice>
          </div>
        ) : (
          <div className="mt-3">
            <SyncInfoNotice variant="red">
              <span className="font-semibold">Error: {result.error}</span>
            </SyncInfoNotice>
          </div>
        )
      )}
    </SyncSection>
  );
}

// ─── Recent Estimates ─────────────────────────────────────────────────────────
function RecentEstimatesPanel() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall('/api/v1/handoff-estimates?sort=-last_synced_at&limit=10', { method: 'GET' })
      .then(r => setEstimates(r.items || r || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading || estimates.length === 0) return null;

  return (
    <SyncSection>
      <SyncSectionHeader icon={Clock} title="Recently Synced" iconColor="text-slate-400"
        badge={{ label: `${estimates.length} shown`, className: "bg-slate-100 text-slate-500" }} />
      <div className="divide-y divide-slate-100">
        {estimates.map(est => (
          <div key={est.id} className="py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate">{est.customer_name}</p>
              <p className="text-[10px] text-slate-400">
                {est.handoff_estimate_number ? `#${est.handoff_estimate_number} · ` : ''}
                {est.estimate_status} · {new Date(est.last_synced_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {est.estimate_amount > 0 && (
                <span className="text-xs font-bold text-slate-700">${est.estimate_amount.toLocaleString()}</span>
              )}
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                est.match_status === 'matched' ? 'bg-emerald-100 text-emerald-700' :
                est.match_status === 'needs_review' ? 'bg-amber-100 text-amber-700' :
                'bg-slate-100 text-slate-500'
              }`}>
                {est.match_status === 'matched' ? '✓ Matched' : est.match_status === 'needs_review' ? 'Review' : 'Unmatched'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </SyncSection>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function HandoffImportTab() {
  return (
    <div className="max-w-2xl space-y-4">

      {/* Source of truth notice */}
      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
        <Database className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-800">QuickBooks is the source of truth for estimates</p>
          <p className="text-xs text-blue-600 mt-0.5">
            Estimates flow from Handoff → QuickBooks → CRM automatically via the QB Direct Sync.
            The Handoff API is not used — direct Handoff API sync has been disabled because it required an unstable session token.
          </p>
        </div>
      </div>

      {/* Handoff-only projects notice */}
      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-800">Handoff project not in QuickBooks yet?</p>
          <p className="text-xs text-amber-700 mt-0.5">
            If a Handoff project has not been invoiced in QuickBooks, it will not appear in the CRM automatically.
            Use the CSV/JSON import below to manually bring it in until it appears in QB.
          </p>
        </div>
      </div>

      <WebhookSetupPanel />
      <CsvImportPanel />
      <RecentEstimatesPanel />
    </div>
  );
}