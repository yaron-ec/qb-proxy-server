/**
 * EstimateFollowUpPanel — Lead Detail section for the automated 14-day
 * estimate follow-up email sequence.
 *
 * Visible to every role Lead Detail itself is visible to — ownership/
 * authorization (admin/manager see everything, office read-only, sales_rep
 * only their own leads) is enforced server-side via the SAME
 * routes/leads.js#resolveOwnerScope every other lead sub-resource reuses;
 * this component never duplicates that check, it just renders what the API
 * returns or a 403.
 *
 * Reply detection is now AUTOMATIC (lib/estimateFollowupReplyDetection.js
 * polls Gmail and pauses a sequence the moment a genuine customer reply is
 * detected — no rep action required in normal operation). The banner below
 * surfaces the live health of that monitoring (never a static claim) since
 * the engine's fail-closed gate holds ALL due sends, for every sequence,
 * whenever reply monitoring is disabled or unhealthy. Pause/Stop below
 * remain available as a manual override for exceptional cases.
 */
import { useEffect, useState, useCallback } from "react";
import { Loader2, Mail, Pause, Play, Square, Eye, CheckCircle2, AlertTriangle, Clock, XCircle } from "lucide-react";
import * as api from "@/api/railway/estimateFollowups";

const STATE_LABEL = {
  not_eligible: "Not Eligible",
  awaiting_sent_confirmation: "Awaiting Sent Confirmation",
  scheduled: "Scheduled",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed",
};

const STATE_BADGE = {
  not_eligible: "bg-slate-100 text-slate-500",
  awaiting_sent_confirmation: "bg-amber-100 text-amber-700",
  scheduled: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  completed: "bg-slate-100 text-slate-700",
  stopped: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
};

const STEP_STATUS_ICON = {
  sent: { Icon: CheckCircle2, color: "text-emerald-600" },
  pending: { Icon: Clock, color: "text-slate-400" },
  processing: { Icon: Loader2, color: "text-blue-500" },
  skipped: { Icon: AlertTriangle, color: "text-amber-500" },
  failed: { Icon: XCircle, color: "text-red-600" },
  cancelled: { Icon: XCircle, color: "text-slate-400" },
};

const ELIGIBILITY_REASON_LABEL = {
  lead_not_found: "Lead not found",
  lead_status_disqualifying: "Lead status disqualifies this sequence (Sold / Lost / DNQ / Cancelled)",
  lead_email_invalid_or_missing: "Lead has no valid email address",
  customer_reminders_disabled: "Customer reminders are disabled for this lead",
  email_suppressed_unsubscribed: "This email address has unsubscribed from estimate follow-ups",
  competing_sequence_already_active: "A follow-up sequence is already active or paused for this lead",
  no_estimate_specified: "No estimate specified",
  no_pending_estimate: "No Pending estimate on this lead",
  multiple_pending_estimates: "Multiple Pending estimates — pick one to enroll",
  estimate_not_found: "Estimate not found",
  estimate_not_linked_to_this_lead: "Estimate is not linked to this lead",
};

function reasonLabel(reason) {
  const key = String(reason).split(":")[0];
  return ELIGIBILITY_REASON_LABEL[key] || reason;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function StepRow({ step }) {
  const { Icon, color } = STEP_STATUS_ICON[step.status] || STEP_STATUS_ICON.pending;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${color} ${step.status === "processing" ? "animate-spin" : ""}`} />
        <span className="text-xs text-slate-700 truncate">Day {step.dayOffset} — Step {step.stepNumber}</span>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[11px] font-semibold text-slate-600 capitalize">{step.status}</div>
        <div className="text-[10px] text-slate-400">
          {step.status === "sent" ? fmtDate(step.sentAt) : fmtDate(step.dueAt)}
        </div>
        {step.skippedReason && <div className="text-[9px] text-amber-600">{step.skippedReason.replace(/_/g, " ")}</div>}
        {step.lastError && <div className="text-[9px] text-red-600 max-w-[180px] truncate" title={step.lastError}>{step.lastError}</div>}
      </div>
    </div>
  );
}

const ENROLLMENT_METHOD_LABEL = {
  manual_enroll: "Manual",
  confirm_sent: "Confirm Sent",
  auto_qb_email_status: "Automatic (QuickBooks)",
  auto_post_appointment_sync: "Automatic (Post-Appointment Sync)",
};

const SYNC_RESULT_LABEL = {
  not_found: "No estimate found yet",
  found_unverified: "Estimate found — awaiting delivery confirmation",
  found_verified_enrolled: "Estimate confirmed sent — enrolled",
  lead_ineligible: "Stopped — lead no longer eligible",
  error: "QuickBooks check failed — will retry",
};

function fmtDateTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

function PostAppointmentSyncSection({ syncs }) {
  if (!syncs || syncs.length === 0) return null;
  return (
    <div className="mb-3 border border-slate-200 rounded">
      <div className="px-2.5 py-1.5 border-b border-slate-100 flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[11px] font-bold text-slate-700">Automatic Post-Appointment QuickBooks Sync</span>
      </div>
      <div className="divide-y divide-slate-100">
        {syncs.map((s) => (
          <div key={s.id} className="px-2.5 py-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700">
                Appointment: {fmtDateTime(s.appointment.startAt)}
                {s.appointment.typeName ? ` (${s.appointment.typeName})` : ""}
              </span>
              <span className="flex items-center gap-1">
                {s.status === "completed" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                {s.status === "stopped" && <XCircle className="w-3.5 h-3.5 text-slate-400" />}
                {s.status === "expired" && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                {(s.status === "pending" || s.status === "processing") && <Loader2 className="w-3.5 h-3.5 text-blue-500" />}
                <span className="text-slate-500">{s.status}</span>
              </span>
            </div>
            <div className="text-slate-500 mt-0.5">
              {s.lastResult ? (SYNC_RESULT_LABEL[s.lastResult] || s.lastResult) : "Not yet checked"}
              {s.lastAttemptAt ? ` — last checked ${fmtDateTime(s.lastAttemptAt)}` : ""}
            </div>
            {s.status === "pending" && s.nextAttemptAt && (
              <div className="text-slate-400">Next check: {fmtDateTime(s.nextAttemptAt)}</div>
            )}
            {s.estimate && (
              <div className="mt-0.5">
                QB Estimate #{s.estimate.qbEstimateNumber} ({s.estimate.estimateStatus}) —{" "}
                {s.estimate.deliveryVerified ? (
                  <span className="text-emerald-700 font-semibold">delivery verified</span>
                ) : (
                  <span className="text-amber-700">delivery not yet verified</span>
                )}
                {s.estimate.qbAppUrl && (
                  <>
                    {" "}
                    <a href={s.estimate.qbAppUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      View in QuickBooks
                    </a>
                  </>
                )}
              </div>
            )}
            {s.stoppedReason && <div className="text-slate-400 mt-0.5">Reason: {s.stoppedReason}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplyMonitoringBanner({ replyMonitoring }) {
  if (!replyMonitoring) return null;
  if (replyMonitoring.enabled && replyMonitoring.healthyForSending) {
    return (
      <div className="mb-2 p-2 bg-emerald-50 border border-emerald-200 rounded text-[10px] text-emerald-800">
        <strong>Automatic reply detection is active.</strong> A genuine customer reply will automatically pause this sequence — no rep action required.
      </div>
    );
  }
  if (replyMonitoring.enabled) {
    return (
      <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800">
        <strong>Reply monitoring is enabled but not currently healthy</strong> (status: {replyMonitoring.status}). Per the fail-closed safety rule, automated estimate follow-up emails are held — for every lead, not just this one — until monitoring recovers. You can still Pause/Stop below if needed.
      </div>
    );
  }
  return (
    <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800">
      <strong>Automatic reply detection is not yet enabled</strong> for this installation. Per the fail-closed safety rule, automated estimate follow-up emails are held — for every lead — until an operator enables it. You can still Pause/Stop below if a customer replies.
    </div>
  );
}

function PreviewModal({ leadId, onClose }) {
  const [previews, setPreviews] = useState(null);
  const [error, setError] = useState(null);
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    api.getPreview(leadId)
      .then((res) => setPreviews(res.previews))
      .catch((e) => setError(e.data?.message || e.message || "Failed to load preview"));
  }, [leadId]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <span className="text-sm font-bold text-slate-800">Estimate Follow-Up — Email Previews</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-sm">Close</button>
        </div>
        {error && <div className="p-4 text-xs text-red-600">{error}</div>}
        {!error && !previews && <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>}
        {previews && (
          <div className="flex flex-1 min-h-0">
            <div className="w-36 border-r border-slate-100 overflow-y-auto flex-shrink-0">
              {previews.map((p, i) => (
                <button
                  key={p.stepNumber}
                  onClick={() => setActiveStep(i)}
                  className={`w-full text-left px-3 py-2 text-[11px] border-b border-slate-50 ${i === activeStep ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  Day {p.dayOffset} (Step {p.stepNumber})
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-[11px] font-semibold text-slate-500 mb-1">Subject</div>
              <div className="text-sm text-slate-800 mb-3">{previews[activeStep].subject}</div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1">Body</div>
              <iframe
                title={`Preview step ${previews[activeStep].stepNumber}`}
                srcDoc={previews[activeStep].html}
                sandbox=""
                className="w-full h-72 border border-slate-200 rounded"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function EstimateFollowUpPanel({ lead, currentUser }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [selectedEstimateId, setSelectedEstimateId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getState(lead.id)
      .then((res) => { setData(res); setLoading(false); })
      .catch((e) => { setError(e.data?.message || e.message || "Failed to load"); setLoading(false); });
  }, [lead.id]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.data?.message || e.message || "Action failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="p-3 flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading estimate follow-up status…
      </div>
    );
  }

  const isAdminOrManager = currentUser?.role === "admin" || currentUser?.role === "manager";
  const state = data?.state;

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-slate-400" />
          <span className="text-xs font-bold text-slate-700">Estimate Email Follow-Up</span>
        </div>
        {state && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>
        )}
      </div>

      <div className="px-3 py-2.5">
        <ReplyMonitoringBanner replyMonitoring={data?.replyMonitoring} />
        <PostAppointmentSyncSection syncs={data?.postAppointmentSyncs} />

        {error && <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">{error}</div>}

        {state === "not_eligible" && (
          <div>
            <p className="text-[11px] text-slate-500 mb-1">This lead is not currently eligible to enroll:</p>
            <ul className="list-disc ml-4 text-[11px] text-slate-600 mb-2">
              {(data.eligibilityReasons || []).map((r) => <li key={r}>{reasonLabel(r)}</li>)}
            </ul>
          </div>
        )}

        {state === "awaiting_sent_confirmation" && (
          <div>
            <p className="text-[11px] text-slate-600 mb-2">
              This lead has a Pending estimate and is eligible to enroll. Enrollment happens automatically once
              QuickBooks itself confirms the estimate was emailed to the customer (EmailStatus=EmailSent) — no
              action is required in normal operation. Use the button below only to confirm/enroll manually for
              an exceptional case (e.g. the estimate was sent a way QuickBooks can't see).
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy}
                onClick={() => run(() => api.confirmSent(lead.id, { handoffEstimateId: selectedEstimateId }))}
                className="px-3 py-1.5 bg-blue-600 text-white text-[11px] font-bold rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Confirm Estimate Sent — Start Sequence
              </button>
              {isAdminOrManager && (
                <button
                  disabled={busy}
                  onClick={() => run(() => api.manualEnroll(lead.id, { handoffEstimateId: selectedEstimateId }))}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-[11px] font-bold rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  Manually Enroll (admin/manager)
                </button>
              )}
              <button onClick={() => setShowPreview(true)} className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-800">
                <Eye className="w-3.5 h-3.5" /> Preview all 6 emails
              </button>
            </div>
          </div>
        )}

        {state === "not_eligible" && (data.eligibilityReasons || []).includes("multiple_pending_estimates") && null}

        {data?.candidateEstimates?.length > 1 && (
          <div className="mt-2 mb-2">
            <label className="text-[10px] font-bold text-slate-500 uppercase">Which estimate?</label>
            <select
              className="w-full mt-1 text-xs border border-slate-200 rounded px-2 py-1"
              value={selectedEstimateId || ""}
              onChange={(e) => setSelectedEstimateId(e.target.value)}
            >
              <option value="">Select an estimate…</option>
              {data.candidateEstimates.map((e) => (
                <option key={e.id} value={e.id}>Estimate #{e.qb_estimate_number || e.id.slice(0, 8)}</option>
              ))}
            </select>
          </div>
        )}

        {data?.sequence && (
          <div>
            <div className="grid grid-cols-2 gap-2 mb-2 text-[11px]">
              <div><span className="text-slate-400">Recipient:</span> {data.sequence.recipientEmail}</div>
              <div><span className="text-slate-400">Enrollment:</span> {ENROLLMENT_METHOD_LABEL[data.sequence.enrollmentMethod] || data.sequence.enrollmentMethod}</div>
              <div><span className="text-slate-400">Sent confirmed:</span> {fmtDate(data.sequence.estimateSentConfirmedAt)}</div>
              <div><span className="text-slate-400">By:</span> {data.sequence.estimateSentConfirmedBy}</div>
            </div>
            {data.sequence.pausedReason && (
              <div className="mb-2 text-[11px] text-amber-700">
                Paused: {data.sequence.pausedReason === "customer_replied" ? "customer replied" : data.sequence.pausedReason} ({data.sequence.pausedBy})
              </div>
            )}
            {data.sequence.stoppedReason && (
              <div className="mb-2 text-[11px] text-red-700">Stopped: {data.sequence.stoppedReason} ({data.sequence.stoppedBy})</div>
            )}

            <div className="mb-2">
              {data.sequence.steps.map((s) => <StepRow key={s.id} step={s} />)}
            </div>

            <div className="flex flex-wrap gap-2">
              <button onClick={() => setShowPreview(true)} className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-800">
                <Eye className="w-3.5 h-3.5" /> Preview
              </button>
              {data.sequence.status === "active" && (
                <button disabled={busy} onClick={() => run(() => api.pause(lead.id, "manual_pause"))} className="flex items-center gap-1 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-[11px] font-bold rounded hover:bg-slate-50 disabled:opacity-50">
                  <Pause className="w-3.5 h-3.5" /> Pause
                </button>
              )}
              {data.sequence.status === "paused" && (
                <button disabled={busy} onClick={() => run(() => api.resume(lead.id))} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-[11px] font-bold rounded hover:bg-emerald-700 disabled:opacity-50">
                  <Play className="w-3.5 h-3.5" /> Resume
                </button>
              )}
              {(data.sequence.status === "active" || data.sequence.status === "paused") && (
                <button disabled={busy} onClick={() => run(() => api.stop(lead.id, "manual_stop"))} className="flex items-center gap-1 px-3 py-1.5 bg-white border border-red-300 text-red-700 text-[11px] font-bold rounded hover:bg-red-50 disabled:opacity-50">
                  <Square className="w-3.5 h-3.5" /> Stop
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {showPreview && <PreviewModal leadId={lead.id} onClose={() => setShowPreview(false)} />}
    </div>
  );
}
