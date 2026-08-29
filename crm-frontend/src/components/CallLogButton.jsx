import { useState } from "react";
import { Phone } from "lucide-react";
import CallLogModal from "./CallLogModal";

export default function CallLogButton({ lead, className = "", onCallLogged }) {
  const [isOpen, setIsOpen] = useState(false);

  const handleClose = () => setIsOpen(false);

  const handleSave = (activity) => {
    onCallLogged?.(activity);
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors ${className}`}
      >
        <Phone className="w-4 h-4" />
        Log Call
      </button>
      <CallLogModal
        lead={lead}
        isOpen={isOpen}
        onClose={handleClose}
        onSave={handleSave}
      />
    </>
  );
}