/**
 * SoldWelcomeEmailPanel — admin-only Lead Detail panel for the automated
 * "Welcome to the EC Construction Group Family!" Sold-customer email
 * (lib/soldWelcomeEmail.js, November 2026).
 *
 * Shows the current send status for this lead (never sent / sent / skipped
 * / failed), an on-demand "Preview" that renders the EXACT branded email
 * this lead would receive (never placeholder branding — real logo/colors/
 * copy, real first name), and a "Send Now" manual-trigger action — gated
 * server-side the same way every other admin write is (requireAuth +
 * requireAdmin), with its own confirmation step since it sends a real
 * customer email.
 *
 * Never auto-runs on page load — status/preview are fetched on demand only,
 * matching ReminderDeliveryDiagnosticsPanel's established convention.
 */
import { useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, Mail, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { previewSoldWelcomeEmail, getSoldWelcomeEmailStatus, sendSoldWelcomeEmail } from "@/api/railway/soldWelcomeEmail";

const STATUS_STYLE = {
  sent: { label: "Sent", badge: "bg-emerald-100 text-emerald-700", icon: CheckCircle2 },
  skipped_no_email: { label: "Skipped — no email on file", badge: "bg-amber-100 text-amber-700", icon: AlertTriangle },
  skipped_invalid_email: { label: "Skipped — invalid email", badge: "bg-amber-100 text-amber-700", icon: AlertTriangle },
  failed: { label: "Failed", badge: "bg-red-100 text-red-700", icon: XCircle },
};

export default function SoldWelcomeEmailPanel({ lead }) {
  const [collapsed, setCollapsed] = useState(true);
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSoldWelcomeEmailStatus(lead.id);
      setStatus(res);
      setCollapsed(false);
    } catch (e) {
      setError(e.data?.message || e.message || "Failed to load status");
      setCollapsed(false);
    } finally {
      setLoading(false);
    }
  };

  const loadPreview = async () => {
    setError(null);
    try {
      const res = await previewSoldWelcomeEmail(lead.id);
      setPreview(res);
    } catch (e) {
      setError(e.data?.message || e.message || "Failed to render preview");
    }
  };

  const doSend = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await sendSoldWelcomeEmail(lead.id);
      await load();
      setConfirmSend(false);
      if (res && res.ok === false) setError(res.error || "Send did not complete");
    } catch (e) {
      setError(e.data?.message || e.message || "Send failed");
    } finally {
      setSending(false);
    }
  };

  const record = status?.record;
  const style = record ? (STATUS_STYLE[record.status] || null) : null;

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        onClick={() => (collapsed ? load() : setCollapsed(true))}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          <Mail className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-bold text-slate-700">Sold Welcome Email</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); load(); }}
          disabled={loading}
          className="flex items-center gap-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 border-t border-slate-100 space-y-3">
          {error && <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">{error}</div>}

          <div className="mt-2 text-[11px] text-slate-700">
            {record ? (
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${style?.badge || "bg-slate-100 text-slate-600"}`}>
                  {style?.icon ? <style.icon className="w-3 h-3" /> : null}
                  {style?.label || record.status}
                </span>
                {record.recipient_email && <span className="text-slate-500">to {record.recipient_email}</span>}
                {record.sent_at && <span className="text-slate-400">· {new Date(record.sent_at).toLocaleString()}</span>}
              </div>
            ) : (
              <span className="text-slate-500">No welcome email attempted for this lead yet.</span>
            )}
            {status && (
              <div className="mt-1 text-[10px] text-slate-400">
                Automatic trigger (on Sold status): {status.autoTriggerEnabled ? "Enabled" : "Disabled"}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadPreview}
              className="text-[11px] font-bold text-blue-600 hover:text-blue-700"
            >
              Preview rendered email
            </button>
            {(!record || record.status !== "sent") && (
              confirmSend ? (
                <span className="flex items-center gap-2">
                  <span className="text-[11px] text-red-700">Send real email to {lead.email || "(no email on file)"}?</span>
                  <button
                    onClick={doSend}
                    disabled={sending || !lead.email}
                    className="text-[11px] font-bold text-red-600 hover:text-red-700 disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Confirm Send"}
                  </button>
                  <button onClick={() => setConfirmSend(false)} className="text-[11px] text-slate-500">Cancel</button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmSend(true)}
                  className="text-[11px] font-bold text-slate-600 hover:text-slate-800"
                >
                  Send Now
                </button>
              )
            )}
          </div>

          {preview && (
            <div className="border border-slate-200 rounded overflow-hidden">
              <div className="bg-slate-50 px-2 py-1 text-[10px] text-slate-500 border-b border-slate-200">Subject: {preview.subject}</div>
              <iframe
                title="Sold welcome email preview"
                srcDoc={preview.html}
                className="w-full"
                style={{ height: 420, border: "none" }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
