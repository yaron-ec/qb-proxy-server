import { useState } from "react";
import { Copy, Check, Code, ChevronDown, ChevronUp, AlertTriangle, Bookmark } from "lucide-react";
import { appParams } from "@/lib/app-params";

function getImportUrl() {
  const base = appParams.appBaseUrl || window.location.origin;
  return `${base}/api/functions/handoffBulkImport`;
}

// Build the full bookmarklet JS from user-provided capture data
function buildBookmarklet({ exportUrl, exportMethod, exportHeaders, exportBodyTemplate, listUrl, listMethod, listHeaders, importUrl }) {
  // Minified but readable bookmarklet
  const script = `
(function() {
  const IMPORT_URL = ${JSON.stringify(importUrl)};
  const EXPORT_URL = ${JSON.stringify(exportUrl)};
  const EXPORT_METHOD = ${JSON.stringify(exportMethod || 'GET')};
  const EXPORT_HEADERS = ${JSON.stringify(exportHeaders)};
  const EXPORT_BODY_TEMPLATE = ${JSON.stringify(exportBodyTemplate || '')};
  const LIST_URL = ${JSON.stringify(listUrl || '')};
  const LIST_METHOD = ${JSON.stringify(listMethod || 'GET')};
  const LIST_HEADERS = ${JSON.stringify(listHeaders || {})};
  const STORAGE_KEY = 'handoff_bulk_import_state';
  const DELAY_MS = 800;

  // ── State management (survives page refresh) ──
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch(e) { return null; }
  }
  function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  function clearState() { localStorage.removeItem(STORAGE_KEY); }

  // ── Overlay UI ──
  const overlay = document.createElement('div');
  overlay.id = '__handoff_importer__';
  overlay.style.cssText = 'position:fixed;bottom:20px;right:20px;width:340px;background:#1e293b;color:#f8fafc;border-radius:12px;padding:16px;z-index:999999;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
  overlay.innerHTML = \`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <strong style="font-size:14px;">📥 Handoff Bulk Import</strong>
      <button id="__hbi_close__" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1;">&times;</button>
    </div>
    <div id="__hbi_status__" style="color:#94a3b8;margin-bottom:8px;">Initializing...</div>
    <div style="background:#0f172a;border-radius:6px;height:6px;margin-bottom:10px;">
      <div id="__hbi_bar__" style="background:#f59e0b;height:6px;border-radius:6px;width:0%;transition:width 0.3s;"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
      <div style="text-align:center;"><div id="__hbi_total__" style="font-size:18px;font-weight:700;color:#f8fafc;">0</div><div style="font-size:10px;color:#64748b;">Total</div></div>
      <div style="text-align:center;"><div id="__hbi_done__" style="font-size:18px;font-weight:700;color:#34d399;">0</div><div style="font-size:10px;color:#64748b;">Imported</div></div>
      <div style="text-align:center;"><div id="__hbi_skip__" style="font-size:18px;font-weight:700;color:#f59e0b;">0</div><div style="font-size:10px;color:#64748b;">Skipped</div></div>
      <div style="text-align:center;"><div id="__hbi_fail__" style="font-size:18px;font-weight:700;color:#f87171;">0</div><div style="font-size:10px;color:#64748b;">Failed</div></div>
    </div>
    <div id="__hbi_log__" style="background:#0f172a;border-radius:6px;padding:6px;max-height:100px;overflow-y:auto;font-size:10px;font-family:monospace;color:#94a3b8;margin-bottom:10px;"></div>
    <div style="display:flex;gap:8px;">
      <button id="__hbi_pause__" style="flex:1;background:#334155;border:none;color:#f8fafc;padding:7px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">⏸ Pause</button>
      <button id="__hbi_clear__" style="flex:1;background:#7f1d1d;border:none;color:#fca5a5;padding:7px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗑 Reset</button>
    </div>
  \`;
  document.body.appendChild(overlay);

  document.getElementById('__hbi_close__').onclick = () => overlay.remove();
  document.getElementById('__hbi_clear__').onclick = () => { clearState(); location.reload(); };

  let paused = false;
  let running = true;
  document.getElementById('__hbi_pause__').onclick = function() {
    paused = !paused;
    this.textContent = paused ? '▶ Resume' : '⏸ Pause';
    this.style.background = paused ? '#166534' : '#334155';
    if (!paused) run();
  };

  function setStatus(msg) { document.getElementById('__hbi_status__').textContent = msg; }
  function setBar(pct) { document.getElementById('__hbi_bar__').style.width = Math.min(pct,100)+'%'; }
  function addLog(msg, color) {
    const el = document.getElementById('__hbi_log__');
    const line = document.createElement('div');
    line.style.color = color || '#94a3b8';
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  function setCount(id, val) { document.getElementById(id).textContent = val; }

  // ── Fetch estimate list ──
  async function fetchEstimateList() {
    // Strategy 1: use the captured list endpoint
    if (LIST_URL) {
      const res = await fetch(LIST_URL, { method: LIST_METHOD, headers: LIST_HEADERS });
      const data = await res.json();
      // Try common shapes
      const items = data.data?.estimates || data.estimates || data.data?.items || data.items || data.data || (Array.isArray(data) ? data : []);
      return items.map(e => ({ id: String(e.id || e.estimateId || ''), number: String(e.number || e.estimateNumber || e.id || '') })).filter(e => e.id);
    }
    // Strategy 2: scrape IDs from the current page DOM
    const links = Array.from(document.querySelectorAll('a[href*="estimate"], a[href*="proposal"]'));
    const ids = [...new Set(links.map(a => { const m = a.href.match(/\\/([a-f0-9-]{8,})/); return m ? m[1] : null; }).filter(Boolean))];
    return ids.map(id => ({ id, number: id }));
  }

  // ── Fetch one export ──
  async function fetchExport(estimateId, estimateNumber) {
    let url = EXPORT_URL.replace(/\\/[a-f0-9-]{8,}\\/|%7B%7BestimateId%7D%7D|{{estimateId}}/g, '/' + estimateId + '/');
    // If URL contains the estimate ID pattern, replace it
    url = url.replace(estimateId.length > 8 ? '' : /PLACEHOLDER/g, estimateId);

    let body = undefined;
    if (EXPORT_BODY_TEMPLATE) {
      body = EXPORT_BODY_TEMPLATE
        .replace(/{{estimateId}}/g, estimateId)
        .replace(/{{estimateNumber}}/g, estimateNumber)
        .replace(/"id"\\s*:\\s*"[^"]*"/g, '"id": "' + estimateId + '"');
    }

    const res = await fetch(url, {
      method: EXPORT_METHOD,
      headers: EXPORT_HEADERS,
      body: body || undefined,
      credentials: 'include',
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';

    if (ct.includes('json')) {
      return { type: 'json', data: await res.json() };
    } else if (ct.includes('csv') || ct.includes('text')) {
      return { type: 'csv', data: await res.text() };
    } else {
      // binary (PDF) — convert to base64 for sending
      const buf = await res.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return { type: 'pdf_b64', data: b64 };
    }
  }

  // ── Send to CRM ──
  async function sendToCRM(estimateId, estimateNumber, exportResult) {
    const res = await fetch(IMPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'bookmarklet',
        estimateId,
        estimateNumber,
        exportType: exportResult.type,
        exportData: exportResult.data,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt.slice(0, 200));
    }
    return res.json();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Main loop ──
  async function run() {
    let state = loadState();

    if (!state) {
      setStatus('Fetching estimate list...');
      const list = await fetchEstimateList();
      if (!list.length) { setStatus('❌ No estimates found on this page.'); return; }
      state = { list, cursor: 0, imported: 0, skipped: 0, failed: 0, errors: [] };
      saveState(state);
      addLog('Found ' + list.length + ' estimates', '#34d399');
    } else {
      addLog('Resuming from estimate ' + state.cursor + '/' + state.list.length, '#f59e0b');
    }

    setCount('__hbi_total__', state.list.length);
    setCount('__hbi_done__', state.imported);
    setCount('__hbi_skip__', state.skipped);
    setCount('__hbi_fail__', state.failed);

    for (let i = state.cursor; i < state.list.length; i++) {
      if (!running) break;
      while (paused) { await sleep(200); }

      const est = state.list[i];
      const pct = Math.round((i / state.list.length) * 100);
      setBar(pct);
      setStatus(\`[\${i+1}/\${state.list.length}] Processing #\${est.number}...\`);

      try {
        const exportResult = await fetchExport(est.id, est.number);
        const result = await sendToCRM(est.id, est.number, exportResult);

        if (result.skipped) {
          state.skipped++;
          addLog('⏭ Skipped #' + est.number + ' (duplicate)', '#f59e0b');
        } else {
          state.imported++;
          addLog('✓ Imported #' + est.number + ' — ' + (result.customer_name || ''), '#34d399');
        }
      } catch (e) {
        state.failed++;
        state.errors.push({ id: est.id, number: est.number, error: e.message });
        addLog('✗ Failed #' + est.number + ': ' + e.message, '#f87171');
      }

      state.cursor = i + 1;
      saveState(state);
      setCount('__hbi_done__', state.imported);
      setCount('__hbi_skip__', state.skipped);
      setCount('__hbi_fail__', state.failed);

      await sleep(DELAY_MS);
    }

    if (state.cursor >= state.list.length) {
      setBar(100);
      setStatus('✅ Complete! ' + state.imported + ' imported, ' + state.skipped + ' skipped, ' + state.failed + ' failed.');
      clearState();
    }
  }

  run().catch(e => { setStatus('Fatal error: ' + e.message); addLog(e.message, '#f87171'); });
})();
  `.trim();

  return 'javascript:' + encodeURIComponent(script);
}

// ─── JSON header parser helper ────────────────────────────────────────────────
function parseHeaders(raw) {
  const out = {};
  (raw || '').split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  });
  return out;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function HandoffBookmarkletGenerator() {
  const [step, setStep] = useState(1); // 1=instructions, 2=capture, 3=listCapture, 4=done
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Export request fields
  const [exportUrl, setExportUrl] = useState('');
  const [exportMethod, setExportMethod] = useState('GET');
  const [exportHeadersRaw, setExportHeadersRaw] = useState('');
  const [exportBody, setExportBody] = useState('');

  // List request fields (optional)
  const [listUrl, setListUrl] = useState('');
  const [listMethod, setListMethod] = useState('GET');
  const [listHeadersRaw, setListHeadersRaw] = useState('');

  const importUrl = getImportUrl();

  const bookmarkletCode = exportUrl.trim() ? buildBookmarklet({
    exportUrl: exportUrl.trim(),
    exportMethod,
    exportHeaders: parseHeaders(exportHeadersRaw),
    exportBodyTemplate: exportBody.trim(),
    listUrl: listUrl.trim(),
    listMethod,
    listHeaders: parseHeaders(listHeadersRaw),
    importUrl,
  }) : null;

  const handleCopyBookmarklet = () => {
    if (!bookmarkletCode) return;
    navigator.clipboard.writeText(bookmarkletCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Bookmark className="w-4 h-4 text-purple-600" />
        <p className="text-sm font-bold text-slate-800">Automated Bulk Export — Bookmarklet</p>
        <span className="text-[10px] font-bold px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">Recommended</span>
      </div>
      <p className="text-xs text-slate-600">
        Capture <strong>one</strong> export request from DevTools, paste it below, then drag the generated bookmarklet to your bookmarks bar.
        Click it once on the Handoff estimates page — it will loop through everything automatically.
      </p>

      {/* Step tabs */}
      <div className="flex gap-0 border border-slate-200 rounded-lg overflow-hidden text-xs font-semibold">
        {[
          { n: 1, label: '1. How to capture' },
          { n: 2, label: '2. Paste export request' },
          { n: 3, label: '3. Get bookmarklet' },
        ].map(s => (
          <button key={s.n} onClick={() => setStep(s.n)}
            className={`flex-1 py-2 transition-colors ${step === s.n ? 'bg-purple-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Step 1: Instructions */}
      {step === 1 && (
        <div className="space-y-3">
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-2">
            <p className="text-xs font-bold text-purple-900">How to capture the export request:</p>
            <ol className="text-xs text-purple-800 space-y-1.5 list-decimal list-inside">
              <li>Open <strong>Handoff</strong> in your browser and go to the Estimates list</li>
              <li>Open <strong>DevTools</strong> (F12 or Cmd+Option+I)</li>
              <li>Click the <strong>Network</strong> tab — enable <em>Preserve log</em></li>
              <li>Open any one estimate, click the <strong>three-dot menu</strong> (⋮), click <strong>Export</strong></li>
              <li>In the Network tab, find the request that triggered the download (look for "export", "csv", "pdf", or "download")</li>
              <li>Right-click that request → <strong>Copy → Copy as cURL</strong></li>
              <li>Come back here and paste the URL, headers, and body in Step 2</li>
            </ol>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <p className="text-xs font-semibold text-amber-800 mb-1">What to look for in Network tab:</p>
            <p className="text-xs text-amber-700">Filter by: <code className="bg-amber-100 px-1 rounded">export</code> or <code className="bg-amber-100 px-1 rounded">csv</code> or <code className="bg-amber-100 px-1 rounded">pdf</code> or <code className="bg-amber-100 px-1 rounded">download</code></p>
            <p className="text-xs text-amber-700 mt-1">You want the request that returns the actual file content, not a UI navigation.</p>
          </div>
          <button onClick={() => setStep(2)}
            className="w-full bg-purple-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700 transition-colors">
            Got it — Paste my request →
          </button>
        </div>
      )}

      {/* Step 2: Capture form */}
      {step === 2 && (
        <div className="space-y-4">
          {/* Export URL */}
          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">Export request URL <span className="text-red-500">*</span></label>
            <p className="text-[10px] text-slate-400 mb-1.5">The URL from the export request. Replace the specific estimate ID with <code className="bg-slate-100 px-1 rounded">{"{{estimateId}}"}</code></p>
            <div className="flex gap-2">
              <select value={exportMethod} onChange={e => setExportMethod(e.target.value)}
                className="border border-slate-300 rounded-lg px-2 py-2 text-xs font-bold text-slate-700 bg-white">
                <option>GET</option><option>POST</option><option>PUT</option>
              </select>
              <input value={exportUrl} onChange={e => setExportUrl(e.target.value)}
                placeholder="https://cement-app.production.1build.com/api/estimates/{{estimateId}}/export"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400" />
            </div>
          </div>

          {/* Export Headers */}
          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">Request headers</label>
            <p className="text-[10px] text-slate-400 mb-1.5">Paste headers (one per line, <code className="bg-slate-100 px-1 rounded">Key: Value</code> format). Must include Authorization header.</p>
            <textarea value={exportHeadersRaw} onChange={e => setExportHeadersRaw(e.target.value)}
              rows={5}
              placeholder={"Authorization: Bearer eyJ...\nContent-Type: application/json\naccept: application/json"}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400" />
          </div>

          {/* Export body (if POST) */}
          {exportMethod !== 'GET' && (
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Request body (optional)</label>
              <p className="text-[10px] text-slate-400 mb-1.5">Use <code className="bg-slate-100 px-1 rounded">{"{{estimateId}}"}</code> where the estimate ID appears.</p>
              <textarea value={exportBody} onChange={e => setExportBody(e.target.value)}
                rows={3}
                placeholder={'{"estimateId": "{{estimateId}}"}'}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400" />
            </div>
          )}

          {/* Advanced: list endpoint */}
          <div>
            <button onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-slate-400 hover:text-slate-600 font-semibold flex items-center gap-1">
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Advanced: provide estimate list endpoint (optional but recommended)
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-[10px] text-slate-500">
                  If you capture the API call that loads the estimates list, the bookmarklet will use it to get all estimate IDs automatically.
                  Otherwise it will scrape IDs from the current page DOM.
                </p>
                <div className="flex gap-2">
                  <select value={listMethod} onChange={e => setListMethod(e.target.value)}
                    className="border border-slate-300 rounded-lg px-2 py-2 text-xs font-bold text-slate-700 bg-white">
                    <option>GET</option><option>POST</option>
                  </select>
                  <input value={listUrl} onChange={e => setListUrl(e.target.value)}
                    placeholder="https://cement-app.production.1build.com/api/estimates?page=1&limit=500"
                    className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400" />
                </div>
                <textarea value={listHeadersRaw} onChange={e => setListHeadersRaw(e.target.value)}
                  rows={3} placeholder={"Authorization: Bearer eyJ...\nContent-Type: application/json"}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400" />
              </div>
            )}
          </div>

          <button
            onClick={() => setStep(3)}
            disabled={!exportUrl.trim() || !exportHeadersRaw.trim()}
            className="w-full bg-purple-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700 disabled:opacity-40 transition-colors">
            Generate Bookmarklet →
          </button>
        </div>
      )}

      {/* Step 3: Generated bookmarklet */}
      {step === 3 && (
        <div className="space-y-4">
          {!bookmarkletCode ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              Go back to Step 2 and fill in the export URL and headers first.
            </div>
          ) : (
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-3">
                <p className="text-xs font-bold text-emerald-800">✅ Your bookmarklet is ready!</p>
                <ol className="text-xs text-emerald-700 space-y-1.5 list-decimal list-inside">
                  <li>Click <strong>Copy Bookmarklet Code</strong> below</li>
                  <li>Open your browser's bookmark manager (Ctrl/Cmd+Shift+B to show bookmarks bar)</li>
                  <li>Create a new bookmark — paste the code as the <strong>URL</strong></li>
                  <li>Name it something like <em>"Handoff Bulk Import"</em></li>
                  <li>Go to Handoff's estimates list page in your browser</li>
                  <li>Click the bookmark — a progress overlay will appear and run automatically</li>
                  <li>You can pause/resume at any time — progress is saved in the browser</li>
                </ol>
              </div>

              {/* Code preview */}
              <div className="bg-slate-900 rounded-lg p-3 overflow-auto max-h-24">
                <code className="text-[9px] font-mono text-green-400 break-all">
                  {bookmarkletCode.slice(0, 300)}...
                </code>
              </div>

              <div className="flex gap-3">
                <button onClick={handleCopyBookmarklet}
                  className="flex-1 flex items-center justify-center gap-2 bg-purple-600 text-white py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700 transition-colors">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied!' : 'Copy Bookmarklet Code'}
                </button>
                <button onClick={() => setStep(2)}
                  className="px-4 border border-slate-300 text-slate-600 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors">
                  Edit
                </button>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5">
                <p className="text-xs font-semibold text-blue-800 mb-1">What happens when you click it:</p>
                <div className="text-xs text-blue-700 space-y-0.5">
                  <div>1. Fetches all estimate IDs from Handoff</div>
                  <div>2. Loops through each — replays your captured export request</div>
                  <div>3. Sends each response to ContractorFlow for parsing + matching</div>
                  <div>4. Shows live progress — skips duplicates automatically</div>
                  <div>5. If interrupted, click bookmark again to resume where it left off</div>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[10px] text-amber-700">
                <strong>Note:</strong> The bookmarklet uses your browser session (cookies) to authenticate with Handoff — it inherits your logged-in state automatically.
                It runs at ~{Math.round(1000/800 * 10)/10} requests/sec to avoid rate limiting.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}