import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { create as createActivity } from "@/api/railway/activities";
import { update as updateLead, updateAppointmentByExternal } from "@/api/railway/leads";
import { X, Loader2 } from "lucide-react";
import AvailableTimePicker from "./AvailableTimePicker";

const CALL_OUTCOMES = [
  "No Answer",
  "No Answer + Voicemail Left",
  "Answered",
  "Wrong Number",
  "Call Back Later",
  "Not Interested",
  "Appointment Scheduled",
  "Follow-up Needed",
];

const CALL_DIRECTIONS = ["Outbound", "Incoming"];

export default function CallLogModal({ lead, isOpen, onClose, onSave }) {
  const [outcome, setOutcome] = useState("");
  const [direction, setDirection] = useState("Outbound");
  const [notes, setNotes] = useState("");
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpTime, setFollowUpTime] = useState("");
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (isOpen) {
      setShowFollowUp(["Follow-up Needed", "Call Back Later"].includes(outcome));
    }
  }, [isOpen, outcome]);

  const handleSave = async () => {
    if (!outcome.trim() || !notes.trim()) {
      alert("Please fill in outcome and notes");
      return;
    }

    setSaving(true);
    try {
      // Create activity record for the call via Railway API
      const activity = await createActivity({
        lead_id: lead.id,
        type: "call",
        content: notes,
        author: user?.full_name || user?.email || "User",
        metadata: {
          call_outcome: outcome,
          call_direction: direction,
        },
        source: "manual",
      });

      // If follow-up needed, create/update follow-up on lead via Railway API
      if (showFollowUp && followUpDate && followUpTime) {
        await updateLead(lead.id, {
          follow_up_date: followUpDate,
          follow_up_time: followUpTime,
          follow_up_type: "Phone Call",
        });
      }

      // If appointment scheduled, update appointment on lead via Railway API
      if (outcome === "Appointment Scheduled" && followUpDate && followUpTime) {
        // Use appointment endpoint for calendar side effects (creates/updates Google Calendar event)
        // lead.id is external_ref (legacy) or Railway UUID (native) — backend matches both.
        await updateAppointmentByExternal(lead.id, {
          appointment_date: followUpDate,
          appointment_time: followUpTime,
          follow_up_date: followUpDate,
          follow_up_time: followUpTime,
          follow_up_type: "Meeting",
        });
        // Update status separately (not handled by appointment endpoint)
        await updateLead(lead.id, {
          status: "Appointment scheduled",
        });
      }

      setSaving(false);
      onSave?.(activity);
      onClose();
      // Reset form
      setOutcome("");
      setNotes("");
      setDirection("Outbound");
      setShowFollowUp(false);
      setFollowUpDate("");
      setFollowUpTime("");
    } catch (e) {
      console.error("Error saving call:", e);
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Log Call</h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Lead Info */}
          <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
            <p className="text-xs font-semibold text-slate-500 uppercase">Lead</p>
            <p className="text-sm font-bold text-slate-900 mt-1">
              {lead.first_name} {lead.last_name}
            </p>
          </div>

          {/* Call Direction */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2">
              Call Direction
            </label>
            <div className="grid grid-cols-2 gap-2">
              {CALL_DIRECTIONS.map((dir) => (
                <button
                  key={dir}
                  onClick={() => setDirection(dir)}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                    direction === dir
                      ? "bg-amber-600 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {dir}
                </button>
              ))}
            </div>
          </div>

          {/* Call Outcome */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2">
              Call Outcome *
            </label>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
            >
              <option value="">— Select outcome</option>
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          {/* Call Notes */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-2">
              Notes *
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened during the call..."
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none multiline-text"
              rows={3}
            />
          </div>

          {/* Follow-up Section */}
          {showFollowUp && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
              <p className="text-xs font-semibold text-amber-900">
                {outcome === "Appointment Scheduled" ? "Appointment Date/Time" : "Follow-up Date/Time"}
              </p>
              
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Date
                </label>
                <input
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Time
                </label>
                <AvailableTimePicker
                  value={followUpTime}
                  onChange={setFollowUpTime}
                  date={followUpDate}
                  ownerName={lead.assigned_rep}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !outcome.trim() || !notes.trim()}
            className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Call"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}