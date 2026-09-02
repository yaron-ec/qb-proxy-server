import { useState, useEffect } from "react";
import * as railwaySettings from "@/api/railway/settings";
import * as railwaySignnow from "@/api/railway/signnow";
import { apiCall } from "@/api/railway/client";
import { useToast } from "@/components/ui/use-toast";
import { FileSignature, Link as LinkIcon, Unlink, Loader2, CheckCircle, Eye, EyeOff, RefreshCw, AlertTriangle, Save } from "lucide-react";
import { RAILWAY_API_URL } from "@/lib/apiConfig";

export default function SignNowSettingsTab() {
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Template management
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateError, setTemplateError] = useState(null);
  const [accountEmail, setAccountEmail] = useState('');
  const [selectedEhicId, setSelectedEhicId] = useState('');
  const [selectedWaiverId, setSelectedWaiverId] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSettingId, setConfigSettingId] = useState(null);

  useEffect(() => {
    const init = async () => {
      await loadStatus();
      await loadSavedConfig();
      // Load templates immediately after status - always attempt it
      await loadTemplates();
    };
    init();
  }, []);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const res = await apiCall('/api/v1/signnow/status', { method: 'GET' }).catch(() => null);
      setStatus(res);
    } catch {
      setStatus({ connected: false });
    }
    setLoading(false);
  };

  const loadSavedConfig = async () => {
    const config = await railwaySettings.get('signnow_template_config').catch(() => null);
    if (config?.value) {
      const c = config.value;
      setConfigSettingId(config.id || 'signnow_template_config');
      if (c.ec_hic_id) setSelectedEhicId(c.ec_hic_id);
      if (c.waiver_id) setSelectedWaiverId(c.waiver_id);
    }
  };

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    setTemplateError(null);
    try {
      const res = await railwaySignnow.listTemplates().catch(e => ({ error: e.message }));
      const data = res;
      if (data?.templates) {
        setTemplates(data.templates);
        setAccountEmail(data.account_email || '');
      } else {
        setTemplateError(data?.error || 'Failed to load templates');
      }
    } catch (e) {
      setTemplateError(e.message || 'Failed to fetch templates from SignNow');
    }
    setLoadingTemplates(false);
  };

  const saveTemplateConfig = async () => {
    if (!selectedEhicId) {
      toast({ title: 'Select the EC HIC template first', variant: 'destructive', duration: 3000 });
      return;
    }
    setSavingConfig(true);
    const ehicTemplate = templates.find(t => t.id === selectedEhicId);
    const waiverTemplate = templates.find(t => t.id === selectedWaiverId);
    const value = {
      ec_hic_id: selectedEhicId,
      ec_hic_name: ehicTemplate?.name || 'EC HIC',
      waiver_id: selectedWaiverId || null,
      waiver_name: waiverTemplate?.name || 'Senior Client Waiver',
    };
    await railwaySettings.upsert('signnow_template_config', value, 'json');
    setConfigSettingId('signnow_template_config');
    toast({ title: '✅ Template configuration saved!', duration: 3000 });
    setSavingConfig(false);
  };

  const handleConnect = async () => {
    if (!username || !password) return;
    setConnecting(true);
    try {
      const res = await apiCall('/api/v1/signnow/connect', { method: 'POST', body: { username, password } }).catch(e => ({ success: false, error: e.message }));
      if (res?.success) {
        toast({ title: '✅ SignNow connected!', duration: 3000 });
        setPassword('');
        loadStatus();
      } else {
        toast({ title: 'Connection failed', description: res?.error || 'Check credentials', variant: 'destructive', duration: 4000 });
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e.message || 'Invalid credentials';
      toast({ title: 'Connection failed', description: msg, variant: 'destructive', duration: 4000 });
    }
    setConnecting(false);
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect SignNow?')) return;
    await apiCall('/api/v1/signnow/disconnect', { method: 'POST' }).catch(() => {});
    setStatus({ connected: false });
    toast({ title: 'SignNow disconnected', duration: 2000 });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <FileSignature className="w-5 h-5 text-orange" /> SignNow Integration
        </h2>
        <p className="text-sm text-slate-500 mt-1">Send contracts for e-signature directly from leads. Track status and auto-save signed PDFs.</p>
      </div>

      {/* Connection Card */}
      <div className={`rounded-lg border p-5 ${status?.connected ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'}`}>
        {loading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking connection...
          </div>
        ) : status?.connected ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center text-xl">✍️</div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-800">SignNow</span>
                  <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">Connected</span>
                </div>
                <div className="text-sm text-slate-600 mt-0.5">{status.name || status.username}</div>
                {status.email && <div className="text-xs text-slate-400">{status.email}</div>}
              </div>
            </div>
            <button onClick={handleDisconnect}
              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors font-semibold">
              <Unlink className="w-3.5 h-3.5" /> Disconnect
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-xl">✍️</div>
              <div>
                <div className="font-bold text-slate-800">SignNow</div>
                <div className="text-xs text-slate-500">Enter your SignNow account credentials</div>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1 block">Email / Username</label>
                <input
                  type="email"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1 block">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none focus:border-orange"
                    onKeyPress={e => e.key === 'Enter' && handleConnect()}
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button
                onClick={handleConnect}
                disabled={!username || !password || connecting}
                className="w-full bg-orange text-white py-2.5 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
                Connect SignNow
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Template Configuration */}
      {status?.connected && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-700">Template Configuration</h3>
              <p className="text-xs text-slate-400 mt-0.5">Select which SignNow templates to use for each contract type</p>
            </div>
            <button
              onClick={loadTemplates}
              disabled={loadingTemplates}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              {loadingTemplates ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Load Templates from SignNow
            </button>
          </div>

          {/* Saved config summary */}
          {(selectedEhicId && templates.length === 0) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-xs text-emerald-700">
              ✅ Templates configured. Click "Load Templates" to change selections.
            </div>
          )}

          {templateError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-700">{templateError}</p>
            </div>
          )}

          {templates.length > 0 && (
            <div className="space-y-4">
              {accountEmail && (
                <div className="text-xs text-slate-500 bg-slate-50 px-3 py-1.5 rounded border border-slate-100">
                  📧 Account: <span className="font-semibold text-slate-700">{accountEmail}</span>
                  <span className="ml-2 text-slate-400">· {templates.length} templates found</span>
                </div>
              )}

              {/* EC HIC selector */}
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">
                  EC HIC Contract Template <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedEhicId}
                  onChange={e => setSelectedEhicId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange"
                >
                  <option value="">— Select EC HIC template —</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {selectedEhicId && (
                  <p className="text-[10px] text-slate-400 mt-1 font-mono">ID: {selectedEhicId}</p>
                )}
              </div>

              {/* Senior Waiver selector */}
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">
                  Senior Client Waiver Template <span className="text-slate-400">(optional)</span>
                </label>
                <select
                  value={selectedWaiverId}
                  onChange={e => setSelectedWaiverId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange"
                >
                  <option value="">— None / Not applicable —</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {selectedWaiverId && (
                  <p className="text-[10px] text-slate-400 mt-1 font-mono">ID: {selectedWaiverId}</p>
                )}
              </div>

              <button
                onClick={saveTemplateConfig}
                disabled={savingConfig || !selectedEhicId}
                className="flex items-center gap-2 bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50"
              >
                {savingConfig ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Template Config
              </button>
            </div>
          )}
        </div>
      )}

      {/* Webhook Setup */}
      {status?.connected && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-5">
          <h3 className="text-sm font-bold text-amber-800 mb-2">⚡ Auto-Sync Webhook (Optional)</h3>
          <p className="text-xs text-amber-700 mb-3">
            To have signed PDFs automatically sync back to the lead without clicking "Sync", 
            register this webhook URL in your SignNow account under <strong>API → Event Subscriptions</strong>.
          </p>
          <div className="bg-white border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
            <code className="text-xs text-slate-700 flex-1 break-all font-mono">
              {RAILWAY_API_URL}/api/v1/signnow-webhook
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(`${RAILWAY_API_URL}/api/v1/signnow-webhook`); }}
              className="text-xs font-semibold text-amber-700 hover:text-amber-900 flex-shrink-0"
            >
              Copy
            </button>
          </div>
          <p className="text-[10px] text-amber-600 mt-2">Events to subscribe: <code>document.complete</code>, <code>document.update</code></p>
        </div>
      )}

      {/* Features list */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-5">
        <h3 className="text-sm font-bold text-slate-700 mb-3">What's included</h3>
        <ul className="space-y-2 text-sm text-slate-600">
          {[
            '📄 Send templates directly from a lead',
            '✉️ Send for e-signature via email invite',
            '👁️ Track status: Draft → Sent → Viewed → Signed / Completed',
            '📎 Auto-save signed PDF to lead attachments on Sync',
            '⚡ Webhook: auto-sync when customer signs (no manual sync needed)',
            '📋 Activity log: "Contract signed and synced from SignNow"',
            '🔗 Open document directly in SignNow',
            '📚 Version history when multiple contracts are sent',
          ].map(f => <li key={f}>{f}</li>)}
        </ul>
      </div>
    </div>
  );
}