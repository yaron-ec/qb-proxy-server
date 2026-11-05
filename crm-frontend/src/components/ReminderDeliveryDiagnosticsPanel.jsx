/**
 * ReminderDeliveryDiagnosticsPanel — admin-only, read-only appointment
 * notification diagnostic for one lead (November 2026).
 *
 * Shows, per appointment: the email reminder status for each of the five
 * scheduled windows (48h/24h/12h/2h/30min), the SMS booking-confirmation
 * status, and the SMS 12h/2h reminder statuses — each labeled Sent /
 * Delivered / Failed / Skipped (with its exact reason when recorded) /
 * Pending retry (quiet hours) / Not yet due / No record / not verified.
 *
 * Calls GET /api/v1/leads/:id/reminder-diagnostics (CRM admin JWT auth,
 * never the X-Worker-Secret-gated cron endpoint) on demand only — never
 * automatically on page load, to avoid an extra DB round trip on every
 * Lead Detail view. Purely a read: this panel can never send a message,
 * change consent, or modify any record.
 */
import { useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle, Clock, HelpCircle } from "lucide-react";
import { getAppointmentNotificationDiagnostics } from "@/api/railway/reminderDiagnostics";

const OUTCOME_STYLE = {
  delivered: { badge: "bg-emerald-100 text-emerald-700", icon: CheckCircle2, iconColor: "text-emerald-600" },
  sent: { badge: "bg-blue-100 text-blue-700", icon: CheckCircle2, iconColor: "text-blue-600" },
  failed: { badge: "bg-red-100 text-red-700", icon: XCircle, iconColor: "text-red-600" },
  skipped: { badge: "bg-amber-100 text-amber-700", icon: AlertTriangle, iconColor: "text-amber-600" },
  pending_retry: { badge: "bg-amber-100 text-amber-700", icon: Clock, iconColor: "text-amber-600" },
  in_progress: { badge: "bg-blue-100 text-blue-700", icon: Loader2, iconColor: "text-blue-600" },
  not_yet_due: { badge: "bg-slate-100 text-slate-600", icon: Clock, iconColor: "text-slate-400" },
  no_record: { badge: "bg-slate-100 text-slate-500 border border-slate-200", icon: HelpCircle, iconColor: "text-slate-400" },
  unknown: { badge: "bg-slate-100 text-slate-500", icon: HelpCircle, iconColor: "text-slate-400" },
};

const WINDOW_LABEL = {
  "48h": "Email — 48 hours before", "24h": "Email — 24 hours before",
  "12h": "Email — 12 hours before", "2h": "Email — 2 hours before", "30min": "Email — 30 minutes before",
  sms_confirmation: "SMS — Booking confirmation",
  sms_12h: "SMS — 12 hours before", sms_2h: "SMS — 2 hours before",
};

function OutcomeBadge({ row }) {
  const style = OUTCOME_STYLE[row.outcome] || OUTCOME_STYLE.unknown;
  const Icon = style.icon;
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${style.badge}`}>
        <Icon className={`w-3 h-3 ${style.iconColor}`} />
        {row.label}
      </span>
      {row.reason && <span className="text-[10px] text-amber-700">{row.reason}</span>}
      {row.detail && <span className="text-[10px] text-slate-500">{row.detail}</span>}
    </div>
  );
}

function NotificationRow({ row }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-b-0">
      <span className="text-xs text-slate-700">{WINDOW_LABEL[row.window] || row.window}</span>
      <OutcomeBadge row={row} />
    </div>
  );
}

export default function ReminderDeliveryDiagnosticsPanel({ lead }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(true);

  const runDiagnostic = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAppointmentNotificationDiagnostics(lead.id);
      setData(res);
      setCollapsed(false);
    } catch (e) {
      // e.message is the generic error code (e.g. "reminder_diagnostics_failed");
      // e.data.message carries the actual failure detail the backend logs.
      // Admin-only route, so showing it is safe and far more actionable.
      setError(e.data?.message || e.message || "Diagnostic failed");
      setCollapsed(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          <span className="text-xs font-bold text-slate-700">Appointment Notification Diagnostics</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); runDiagnostic(); }}
          disabled={loading}
          className="flex items-center gap-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Check
        </button>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 border-t border-slate-100">
          {error && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">{error}</div>
          )}

          {!error && !data && (
            <p className="text-[11px] text-slate-500 mt-2">Click "Check" to run this read-only diagnostic.</p>
          )}

          {data && !data.found && (
            <p className="text-[11px] text-slate-500 mt-2">{data.message || "Lead not found."}</p>
          )}

          {data && data.found && (
            <div className="mt-2 space-y-3">
              <div className="p-2 bg-slate-50 rounded text-[11px] text-slate-700">
                <div>
                  <span className="font-semibold">Appointment:</span>{" "}
                  {data.appointment.date && data.appointment.time
                    ? `${data.appointment.date} at ${data.appointment.time} (${data.appointment.resolved_from === "live_appointment_record" ? "live appointment record" : "reminder projection"})`
                    : "none found"}
                </div>
                {data.appointment.status && (
                  <div className="text-slate-500 mt-0.5">Appointment status: {data.appointment.status}</div>
                )}
                <div className="text-slate-500 mt-0.5">
                  SMS consent on file: <span className={data.lead.sms_consent ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>{data.lead.sms_consent ? "Yes" : "No"}</span>
                </div>
              </div>

              {!data.notifications && (
                <p className="text-[11px] text-slate-500">{data.appointment.note || "No appointment date/time available to diagnose."}</p>
              )}

              {data.notifications && (
                <>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Email reminders</div>
                    {data.notifications.email.map((row) => <NotificationRow key={row.window} row={row} />)}
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">SMS</div>
                    <NotificationRow row={data.notifications.sms_confirmation} />
                    {data.notifications.sms.map((row) => <NotificationRow key={row.window} row={row} />)}
                  </div>
                </>
              )}

              <div className="text-[9px] text-slate-400">Generated: {new Date(data.generated_at).toLocaleString()}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
