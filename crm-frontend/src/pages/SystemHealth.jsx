import { useState, useEffect } from "react";
import * as railwaySystemInfo from "@/api/railway/systemInfo";
import { useAuth } from "@/lib/AuthContext";
import { CheckCircle2, AlertTriangle, XCircle, Circle, RefreshCw, Zap } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/DesignSystem/Card";
import { PageTitle, PageSubtitle, SectionTitle, HelperText } from "@/components/DesignSystem/SectionHeader";
import { Button } from "@/components/DesignSystem/Button";
import { StatusBadge } from "@/components/DesignSystem/Badge";
import { Alert } from "@/components/DesignSystem/Alert";

/**
 * SystemHealth — Admin-only System Health page (PRODUCTIZATION PHASE 2,
 * Section 8; redesigned + real-integration-audit pass), backed by
 * GET /api/v1/system/info. Never renders a secret value — the endpoint
 * itself never returns one, only credential presence, generic status
 * metadata, and missing-env-var NAMES.
 *
 * Two distinct refreshes:
 *   - "Refresh" — fast, local, credential-presence-only (no outbound calls).
 *   - "Run Live Checks" (?verify=1) — genuine read-only connectivity checks
 *     against each configured integration. Slower, rate-limited server-side.
 */

const STATE_CONFIG = {
  CONNECTED:      { icon: CheckCircle2, variant: "success", label: "Connected" },
  DEGRADED:       { icon: AlertTriangle, variant: "warning", label: "Degraded" },
  DISCONNECTED:   { icon: XCircle,      variant: "error",   label: "Disconnected" },
  CONFIGURED:     { icon: Circle,       variant: "info",    label: "Configured" },
  NOT_CONFIGURED: { icon: Circle,       variant: "default", label: "Not Configured" },
  DISABLED:       { icon: Circle,       variant: "draft",   label: "Disabled" },
};

function StateBadge({ state }) {
  const s = STATE_CONFIG[state] || STATE_CONFIG.NOT_CONFIGURED;
  const Icon = s.icon;
  return (
    <StatusBadge variant={s.variant} className="gap-1">
      <Icon className="w-3 h-3" />
      {s.label}
    </StatusBadge>
  );
}

const MODULE_LABELS = {
  quickbooks: "QuickBooks", gmail: "Gmail", google_calendar: "Google Calendar",
  google_contacts: "Google Contacts", signnow: "SignNow", handoff: "Handoff",
  meta: "Meta / Facebook Lead Ads", sms: "Twilio (SMS)", website_intake: "Website Lead Intake",
};

const MODULE_ORDER = [
  "quickbooks", "gmail", "google_calendar", "google_contacts",
  "signnow", "handoff", "meta", "sms", "website_intake",
];

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function IntegrationCard({ moduleKey, data }) {
  const label = MODULE_LABELS[moduleKey] || moduleKey;
  const lc = data.live_check;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">{label}</span>
        <StateBadge state={data.state} />
      </CardHeader>
      <CardContent className="space-y-2">
        {!data.module_enabled && data.flag_enforced && (
          <HelperText>Not enabled for this installation (Company Settings).</HelperText>
        )}
        {!data.module_enabled && !data.flag_enforced && (
          <HelperText>Disabled in Company Settings, but this toggle has no effect yet for this integration — state below reflects actual credential/connection evidence.</HelperText>
        )}
        {data.missing_env && data.missing_env.length > 0 && (
          <HelperText>Missing: {data.missing_env.join(", ")}</HelperText>
        )}
        {data.credential_source && data.credential_source !== "none" && (
          <HelperText>Credential source: {data.credential_source.replace(/_/g, " ")}</HelperText>
        )}
        {lc && (
          <div className="text-xs text-slate-600 bg-slate-50 rounded-md px-2.5 py-2 leading-snug">
            {lc.message}
            <div className="text-[10px] text-slate-400 mt-1">Checked {fmt(lc.checked_at)}</div>
          </div>
        )}
        {!lc && data.state === "CONFIGURED" && !data.supports_live_check && (
          <HelperText>Live connectivity check is not available for this integration — install-specific impersonation/account setup is required.</HelperText>
        )}
        {data.recency && (
          <HelperText>
            Last lead received {fmt(data.recency.last_lead_received_at)} · {data.recency.total_leads_received ?? 0} total
          </HelperText>
        )}
        {data.sync_evidence && (
          <HelperText>
            Sync: {data.sync_evidence.pending_count ?? 0} pending/retrying
            {data.sync_evidence.dead_count > 0 ? ` · ${data.sync_evidence.dead_count} permanently failed` : ""}
            {" "}· last synced {fmt(data.sync_evidence.last_synced_at)}
          </HelperText>
        )}
        {data.end_to_end && (
          <div className={`text-xs rounded-md px-2.5 py-2 leading-snug ${data.end_to_end.verified ? "text-emerald-700 bg-emerald-50" : "text-slate-600 bg-slate-50"}`}>
            {data.end_to_end.verified ? "✓ " : ""}{data.end_to_end.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SystemHealth() {
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);

  const load = (verify = false) => {
    (verify ? setVerifying : setLoading)(true);
    setError(null);
    railwaySystemInfo.get({ verify })
      .then((res) => setInfo(res))
      .catch((e) => setError(e?.message || "Failed to load system info"))
      .finally(() => (verify ? setVerifying : setLoading)(false));
  };

  useEffect(() => { load(false); }, []);

  if (user && user.role !== "admin") {
    return (
      <div className="min-h-full bg-background">
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <PageTitle>System Health</PageTitle>
          <p className="text-slate-500 mt-2">This page is available to admins only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'max(env(safe-area-inset-top), 1.5rem)' }}>
      <div className="max-w-[1600px] mx-auto px-6 py-8 space-y-10">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <PageTitle>System Health</PageTitle>
            <PageSubtitle>
              {info?.installation?.company_name ? `${info.installation.company_name} · ` : ""}
              Installation status and per-integration connectivity
            </PageSubtitle>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load(false)} disabled={loading || verifying}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => load(true)} disabled={loading || verifying}>
              <Zap className={`w-3.5 h-3.5 ${verifying ? "animate-pulse" : ""}`} />
              {verifying ? "Running Live Checks…" : "Run Live Checks"}
            </Button>
          </div>
        </div>

        {error && <Alert variant="error" title="Failed to load System Health">{error}</Alert>}

        {info && (
          <>
            {/* Installation */}
            <section className="space-y-3">
              <SectionTitle>Installation</SectionTitle>
              <Card>
                <CardContent>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                    <div>
                      <dt className="text-slate-500 text-xs">Company</dt>
                      <dd className="text-slate-800 font-medium">{info.installation?.company_name || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs">Installation ID</dt>
                      <dd className="text-slate-800 font-mono text-xs">{info.installation?.installation_id || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs">Product version</dt>
                      <dd className="text-slate-800">{info.product_version || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs">Build commit</dt>
                      <dd className="text-slate-800 font-mono text-xs">{info.build_commit ? info.build_commit.slice(0, 12) : "unknown"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs">Migrations applied</dt>
                      <dd className="text-slate-800">{info.schema?.migrations_applied ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs">Last migration</dt>
                      <dd className="text-slate-800">{fmt(info.schema?.last_migration_applied_at)}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </section>

            {/* Integrations */}
            <section className="space-y-3">
              <SectionTitle>Integrations</SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {MODULE_ORDER
                  .filter((key) => info.integrations?.[key])
                  .map((key) => (
                    <IntegrationCard key={key} moduleKey={key} data={info.integrations[key]} />
                  ))}
              </div>
            </section>

            <p className="text-xs text-slate-400 text-center">
              Generated {fmt(info.generated_at)}
              {info.verified ? " · live connectivity checks included" : " · credential-presence only (click “Run Live Checks” to verify)"}
              {" "}— no secret values are ever shown here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
