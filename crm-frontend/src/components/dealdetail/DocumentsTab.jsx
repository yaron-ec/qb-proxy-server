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
          <SignNowPanel lead={lead} onLeadUpdate={setLead} />
        </div>
      </div>

      {/* Uploads */}
      <div>
        <p className="typography-section-header mb-2">UPLOADS & FILES</p>
        <div className="card-premium overflow-hidden">
          <AttachmentsPanel lead={lead} />
        </div>
      </div>
    </div>
  );
}