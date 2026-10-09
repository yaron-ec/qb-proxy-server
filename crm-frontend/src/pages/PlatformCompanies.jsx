import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { useAuth } from "@/lib/AuthContext";
import { Plus, RefreshCw, Loader2, Server, Mail, PauseCircle, PlayCircle, X, Zap, DollarSign } from "lucide-react";
import { Card, CardContent } from "@/components/DesignSystem/Card";
import { PageTitle, PageSubtitle, SectionTitle, HelperText } from "@/components/DesignSystem/SectionHeader";
import { Button } from "@/components/DesignSystem/Button";
import { StatusBadge } from "@/components/DesignSystem/Badge";
import { Alert } from "@/components/DesignSystem/Alert";

/**
 * PlatformCompanies — Company Management (PRODUCTIZATION — multi-company
 * onboarding workflow). Platform-admin-only (gated both server-side,
 * lib/rbac.js#requirePlatformAdmin, and client-side here via
 * user.is_platform_admin from GET /api/auth/me — the server check is the
 * real boundary; this page simply never renders for anyone else).
 *
 * Backed by routes/platformCompanies.js. The ONE step this page cannot
 * automate is creating the actual Railway project/Postgres/services for a
 * new company (docs/INSTALL_NEW_COMPANY.md's own documented reason: Railway
 * has no safe, scriptable way to do this without the operator's own
 * account token, and creating billable infrastructure deserves its own
 * in-the-moment human decision) — "Mark Infrastructure Ready" is where an
 * admin, having already done that by hand, tells this page where it is.
 */

const STATUS_CONFIG = {
  draft:                   { label: "Draft", variant: "default" },
  awaiting_infrastructure: { label: "Awaiting Infrastructure", variant: "warning" },
  provisioning:            { label: "Provisioning…", variant: "info" },
  provisioning_failed:     { label: "Provisioning Failed", variant: "error" },
  ready_to_invite:         { label: "Ready to Invite", variant: "info" },
  invited:                 { label: "Invited", variant: "success" },
  activated:               { label: "Activated", variant: "success" },
  suspended:               { label: "Suspended", variant: "error" },
  failed:                  { label: "Failed", variant: "error" },
};

function StatusPill({ status }) {
  const s = STATUS_CONFIG[status] || { label: status, variant: "default" };
  return <StatusBadge variant={s.variant}>{s.label}</StatusBadge>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors";
const labelCls = "block text-xs font-semibold text-slate-600 mb-1.5";

function AddCompanyModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ company_name: "", owner_email: "", owner_name: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await apiCall("/api/v1/platform/companies", { method: "POST", body: form });
      onCreated(res.company);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to create company");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add Company" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelCls}>Company Name</label>
          <input className={inputCls} required value={form.company_name}
            onChange={(e) => setForm((p) => ({ ...p, company_name: e.target.value }))} placeholder="Acme Remodeling" />
        </div>
        <div>
          <label className={labelCls}>Owner's Email Address</label>
          <input className={inputCls} type="email" required value={form.owner_email}
            onChange={(e) => setForm((p) => ({ ...p, owner_email: e.target.value }))} placeholder="owner@acme.example" />
        </div>
        <div>
          <label className={labelCls}>Owner's Name <span className="text-slate-400 font-normal">(optional)</span></label>
          <input className={inputCls} value={form.owner_name}
            onChange={(e) => setForm((p) => ({ ...p, owner_name: e.target.value }))} placeholder="Jordan Admin" />
        </div>
        <HelperText>
          This creates an empty, isolated record for this company. Nothing is deployed and no invitation is sent yet — the next step is standing up its Railway infrastructure, then marking it ready below.
        </HelperText>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2">
          {/* Native button, not DesignSystem's <Button>: it doesn't forward a
              `type` prop, so inside a <form> it would default to type="submit"
              and incorrectly submit the form on Cancel. */}
          <button type="button" onClick={onClose} className="border border-slate-200 px-4 h-8 text-xs font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
          <Button size="sm" disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {saving ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function InfrastructureModal({ company, onClose, onDone }) {
  const [form, setForm] = useState({
    database_url: "",
    frontend_url: company.frontend_url || `https://crm.${company.company_slug}.example`,
    backend_url: company.backend_url || `https://${company.company_slug}-api.up.railway.app`,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await apiCall(`/api/v1/platform/companies/${company.id}/infrastructure`, { method: "POST", body: form });
      onDone(res);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to provision");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Mark Infrastructure Ready — ${company.company_name}`} onClose={onClose}>
      <HelperText>
        Paste the connection details for the Railway project/Postgres/services you've already created by hand for this company (see docs/INSTALL_NEW_COMPANY.md Step 2). This runs migrations, seeds the company's settings and a pending admin account, then emails the owner's activation link.
      </HelperText>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelCls}>Database Connection String</label>
          <input className={inputCls} required value={form.database_url}
            onChange={(e) => setForm((p) => ({ ...p, database_url: e.target.value }))} placeholder="postgres://user:pass@host:5432/db" />
        </div>
        <div>
          <label className={labelCls}>Frontend URL</label>
          <input className={inputCls} required value={form.frontend_url}
            onChange={(e) => setForm((p) => ({ ...p, frontend_url: e.target.value }))} />
        </div>
        <div>
          <label className={labelCls}>Backend URL</label>
          <input className={inputCls} required value={form.backend_url}
            onChange={(e) => setForm((p) => ({ ...p, backend_url: e.target.value }))} />
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-slate-200 px-4 h-8 text-xs font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
          <Button size="sm" disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}
            {saving ? "Provisioning…" : "Provision & Invite Owner"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AutoProvisionModal({ company, onClose, onDone }) {
  const [estimate, setEstimate] = useState(null);
  const [railwayAvailable, setRailwayAvailable] = useState(null);
  const [loadingEstimate, setLoadingEstimate] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiCall(`/api/v1/platform/companies/${company.id}/estimate`, { method: "POST" })
      .then((res) => {
        if (cancelled) return;
        setEstimate(res.estimate);
        setRailwayAvailable(res.railway_automation_available);
      })
      .catch((e) => !cancelled && setError(e?.message || "Failed to compute estimate"))
      .finally(() => !cancelled && setLoadingEstimate(false));
    return () => { cancelled = true; };
  }, [company.id]);

  const confirmAndProvision = async () => {
    setProvisioning(true);
    setError("");
    try {
      const res = await apiCall(`/api/v1/platform/companies/${company.id}/provision`, {
        method: "POST",
        body: { confirm_cost_usd: estimate.estimated_monthly_usd_high },
      });
      onDone(res);
      onClose();
    } catch (err) {
      setError(err?.message || "Automated provisioning failed — safe to retry, it resumes from where it left off");
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <Modal title={`Provision Automatically — ${company.company_name}`} onClose={onClose}>
      {loadingEstimate && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Computing estimate…</div>}
      {!loadingEstimate && railwayAvailable === false && (
        <Alert variant="warning" title="Automated provisioning not available">
          RAILWAY_API_TOKEN is not configured on this installation. Use "Mark Infrastructure Ready" instead, or ask an operator to configure RAILWAY_API_TOKEN to enable this.
        </Alert>
      )}
      {!loadingEstimate && estimate && (
        <>
          <div className="space-y-2">
            {estimate.services.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-xs text-slate-600 border-b border-slate-100 pb-1.5">
                <span>{s.role}{s.optional ? " (optional)" : ""}</span>
                <span className="font-mono">${s.low_usd}–${s.high_usd}/mo</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-2">
            <span className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><DollarSign className="w-4 h-4" /> Estimated total</span>
            <span className="text-sm font-bold text-slate-900">${estimate.estimated_monthly_usd_low}–${estimate.estimated_monthly_usd_high}/mo</span>
          </div>
          <HelperText>{estimate.basis}</HelperText>
          <HelperText>
            Clicking Confirm creates a real, billable Railway project + Postgres + services for this company, deploys the shared codebase to it, runs migrations, and emails the owner's activation link. This is safe to retry if it fails partway — it resumes rather than re-creating anything.
          </HelperText>
        </>
      )}
      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="border border-slate-200 px-4 h-8 text-xs font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
        {railwayAvailable !== false && (
          <Button size="sm" disabled={loadingEstimate || provisioning || !estimate} onClick={confirmAndProvision}>
            {provisioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {provisioning ? "Provisioning… (may take a few minutes)" : `Confirm $${estimate?.estimated_monthly_usd_high ?? "…"}/mo & Provision`}
          </Button>
        )}
      </div>
    </Modal>
  );
}

function CompanyRow({ company, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [showInfra, setShowInfra] = useState(false);
  const [showAutoProvision, setShowAutoProvision] = useState(false);
  const [notice, setNotice] = useState(null);

  const resendInvite = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiCall(`/api/v1/platform/companies/${company.id}/resend-invite`, { method: "POST" });
      setNotice(res.email_sent ? "Invite resent." : `Invite link (copy manually — email not sent): ${res.invite_url}`);
      onChanged();
    } catch (e) {
      setNotice(e?.message || "Failed to resend invite");
    } finally {
      setBusy(false);
    }
  };

  const toggleSuspend = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const action = company.status === "suspended" ? "activate" : "suspend";
      await apiCall(`/api/v1/platform/companies/${company.id}/${action}`, { method: "POST" });
      onChanged();
    } catch (e) {
      setNotice(e?.message || "Failed to update status");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800">{company.company_name}</div>
            <div className="text-xs text-slate-400">{company.company_slug} · {company.owner_email}</div>
          </div>
          <StatusPill status={company.status} />
        </div>
        {company.backend_url && <div className="text-xs text-slate-500">{company.backend_url}</div>}
        {company.last_error && company.status === "provisioning_failed" && (
          <div className="text-xs rounded-md px-2.5 py-2 bg-red-50 text-red-700 break-all">{company.last_error}</div>
        )}
        {notice && <div className="text-xs rounded-md px-2.5 py-2 bg-slate-50 text-slate-600 break-all">{notice}</div>}
        <div className="flex flex-wrap gap-2 pt-1">
          {["draft", "awaiting_infrastructure", "provisioning_failed"].includes(company.status) && (
            <>
              <Button size="sm" onClick={() => setShowAutoProvision(true)}>
                <Zap className="w-3.5 h-3.5" /> {company.status === "provisioning_failed" ? "Retry Automated Provisioning" : "Provision Automatically"}
              </Button>
              {!company.has_infrastructure && (
                <Button size="sm" variant="secondary" onClick={() => setShowInfra(true)}>
                  <Server className="w-3.5 h-3.5" /> Mark Infrastructure Ready (Manual)
                </Button>
              )}
            </>
          )}
          {company.has_infrastructure && !["provisioning", "suspended"].includes(company.status) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={resendInvite}>
              <Mail className="w-3.5 h-3.5" /> Resend Invite
            </Button>
          )}
          {company.has_infrastructure && company.status !== "provisioning" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={toggleSuspend}>
              {company.status === "suspended" ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
              {company.status === "suspended" ? "Activate" : "Suspend"}
            </Button>
          )}
        </div>
      </CardContent>
      {showInfra && (
        <InfrastructureModal company={company} onClose={() => setShowInfra(false)} onDone={(res) => {
          setNotice(res.email_sent ? "Owner invited." : `Invite link (copy manually — email not sent): ${res.invite_url}`);
          onChanged();
        }} />
      )}
      {showAutoProvision && (
        <AutoProvisionModal company={company} onClose={() => setShowAutoProvision(false)} onDone={(res) => {
          setNotice(res.email_sent ? "Owner invited." : `Invite link (copy manually — email not sent): ${res.invite_url}`);
          onChanged();
        }} />
      )}
    </Card>
  );
}

export default function PlatformCompanies() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    apiCall("/api/v1/platform/companies", { method: "GET" })
      .then((res) => setItems(res.items || []))
      .catch((e) => setError(e?.message || "Failed to load companies"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (user && !user.is_platform_admin) {
    return (
      <div className="min-h-full bg-background">
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <PageTitle>Company Management</PageTitle>
          <p className="text-slate-500 mt-2">This page is available to platform administrators only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'max(env(safe-area-inset-top), 1.5rem)' }}>
      <div className="max-w-[1100px] mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <PageTitle>Company Management</PageTitle>
            <PageSubtitle>Provision and manage every company installation of this CRM product.</PageSubtitle>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="w-3.5 h-3.5" /> Add Company
            </Button>
          </div>
        </div>

        {error && <Alert variant="error" title="Failed to load companies">{error}</Alert>}

        <section className="space-y-3">
          <SectionTitle>Companies ({items.length})</SectionTitle>
          {items.length === 0 && !loading && (
            <Card><CardContent><p className="text-sm text-slate-500 py-4 text-center">No companies yet. Click "Add Company" to provision the first one.</p></CardContent></Card>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.map((c) => <CompanyRow key={c.id} company={c} onChanged={load} />)}
          </div>
        </section>
      </div>
      {showAdd && <AddCompanyModal onClose={() => setShowAdd(false)} onCreated={() => load()} />}
    </div>
  );
}
