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
 * IMPORTANT, surfaced prominently rather than silently assumed: this CRM has
 * no automatic inbound-email reply detection for this sequence (Gmail
 * integration is outbound-send only). A customer reply does NOT
 * automatically pause/stop the sequence — a rep must do so manually via the
 * Pause/Stop controls below.
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
        <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800">
          <strong>No automatic reply detection:</strong> {data?.replyDetectionLimitation}
        </div>

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
              This lead has a Pending estimate and is eligible to enroll. No automatic enrollment happens —
              confirm below only once the estimate has genuinely been sent/presented to the customer.
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
              <div><span className="text-slate-400">Enrollment:</span> {data.sequence.enrollmentMethod === "manual_enroll" ? "Manual" : "Confirm Sent"}</div>
              <div><span className="text-slate-400">Sent confirmed:</span> {fmtDate(data.sequence.estimateSentConfirmedAt)}</div>
              <div><span className="text-slate-400">By:</span> {data.sequence.estimateSentConfirmedBy}</div>
            </div>
            {data.sequence.pausedReason && (
              <div className="mb-2 text-[11px] text-amber-700">Paused: {data.sequence.pausedReason} ({data.sequence.pausedBy})</div>
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
