/**
 * DocumentsTab — contracts (SignNow) and file uploads (attachments).
 */
import SignNowPanel from "@/components/SignNowPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";

export default function DocumentsTab({ lead, setLead }) {
  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
      {/* Contracts */}
      <div>
        <p className="typography-section-header mb-2">CONTRACTS</p>
        <div className="card-premium overflow-hidden">
          {lead ? <SignNowPanel lead={lead} onLeadUpdate={setLead} /> : <p className="text-sm text-slate-400 py-3 px-4">No lead linked.</p>}
        </div>
      </div>

      {/* Uploads */}
      <div>
        <p className="typography-section-header mb-2">UPLOADS & FILES</p>
        <div className="card-premium overflow-hidden">
          {lead ? <AttachmentsPanel lead={lead} /> : <p className="text-sm text-slate-400 py-3 px-4">No lead linked.</p>}
        </div>
      </div>
    </div>
  );
}