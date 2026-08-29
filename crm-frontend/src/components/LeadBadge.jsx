const STATUS_MAP = {
  "New": "bg-blueprint text-white",
  "Contacted": "bg-muted text-foreground",
  "Qualified": "bg-emerald-600 text-white",
  "Consultation Scheduled": "bg-blueprint/80 text-white",
  "Estimate Sent": "bg-orange/20 text-orange border border-orange",
  "Proposal Sent": "bg-orange text-white",
  "Won": "bg-emerald-700 text-white",
  "Lost": "bg-destructive text-white",
  "Unqualified": "bg-muted text-muted-foreground",
};

export default function LeadBadge({ status }) {
  const cls = STATUS_MAP[status] || "bg-muted text-foreground";
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase font-mono rounded-sm ${cls}`}>
      {status}
    </span>
  );
}