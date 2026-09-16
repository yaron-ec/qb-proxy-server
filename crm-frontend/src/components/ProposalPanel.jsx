import { ExternalLink } from "lucide-react";

/**
 * ProposalPanel
 * 
 * Simple button to open Handoff website directly.
 * Copies lead details to clipboard for manual entry.
 */
export default function ProposalPanel({ lead }) {
  const handleOpenHandoff = () => {
    // Copy lead details to clipboard
    const details = [
      `Customer: ${lead.first_name} ${lead.last_name}`,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.email ? `Email: ${lead.email}` : null,
      lead.property_address ? `Address: ${lead.property_address}` : null,
      lead.city ? `City: ${lead.city}` : null,
      lead.project_type ? `Job Type: ${lead.project_type}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    navigator.clipboard.writeText(details).then(() => {
      // Open Handoff in new tab
      window.open("https://app.handoff.ai", "_blank");
    }).catch(() => {
      // Fallback if clipboard fails
      window.open("https://app.handoff.ai", "_blank");
    });
  };

  // A secondary integration action, not the centerpiece of Lead Detail — the
  // customer's identity/status/next-action (left column) should dominate,
  // not a solid full-width blue button sitting above the activity feed.
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-600">Create Estimate</p>
        <p className="text-[11px] text-slate-400 truncate">Opens Handoff.ai — lead details copied to clipboard</p>
      </div>
      <button
        onClick={handleOpenHandoff}
        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Open Handoff
      </button>
    </div>
  );
}