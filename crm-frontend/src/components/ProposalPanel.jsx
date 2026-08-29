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

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-slate-900">Create Estimate</h3>
      
      <button
        onClick={handleOpenHandoff}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        Open Handoff
      </button>
      
      <p className="text-xs text-slate-500">
        Opens Handoff.ai in a new tab. Lead details copied to clipboard.
      </p>
    </div>
  );
}