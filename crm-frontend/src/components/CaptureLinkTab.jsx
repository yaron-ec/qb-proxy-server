import { useState, useEffect, useRef } from "react";
import { Copy, Check, QrCode, ExternalLink, Smartphone } from "lucide-react";

export default function CaptureLinkTab() {
  const [copied, setCopied] = useState(false);
  const [qrLoaded, setQrLoaded] = useState(false);

  const captureUrl = `${window.location.origin}/capture`;

  const copy = () => {
    navigator.clipboard.writeText(captureUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // QR code via free API (no signup needed)
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(captureUrl)}&color=92400e&bgcolor=fffbeb`;

  return (
    <div className="max-w-2xl space-y-6">
      {/* URL Card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Smartphone className="w-4 h-4 text-amber-600" />
          <h2 className="text-sm font-bold text-slate-800">Call Center Capture Form</h2>
        </div>
        <p className="text-sm text-slate-500 mb-5">
          Share this link with your call center agents. No login required — agents can open it on any device and submit leads directly into the CRM.
        </p>

        {/* Link display */}
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm font-mono text-slate-700 truncate">
            {captureUrl}
          </div>
          <button
            onClick={copy}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap
              ${copied ? "bg-emerald-600 text-white" : "bg-amber-600 hover:bg-amber-700 text-white"}`}
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? "Copied!" : "Copy Link"}
          </button>
          <a
            href={captureUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <ExternalLink className="w-4 h-4" />
            Open
          </a>
        </div>
      </div>

      {/* QR Code Card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <QrCode className="w-4 h-4 text-amber-600" />
          <h2 className="text-sm font-bold text-slate-800">QR Code</h2>
        </div>
        <p className="text-sm text-slate-500 mb-5">
          Print or display this QR code so agents can scan it on their phone or tablet to open the form instantly.
        </p>
        <div className="flex flex-col items-center gap-4">
          <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-5 inline-block">
            {!qrLoaded && (
              <div className="w-[220px] h-[220px] flex items-center justify-center text-slate-300">
                <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <img
              src={qrUrl}
              alt="QR Code for capture form"
              className={`w-[220px] h-[220px] rounded-lg ${qrLoaded ? "block" : "hidden"}`}
              onLoad={() => setQrLoaded(true)}
            />
          </div>
          <a
            href={qrUrl}
            download="ec-capture-qr.png"
            className="flex items-center gap-2 text-xs font-semibold text-amber-700 hover:underline"
          >
            ⬇ Download QR Code
          </a>
        </div>
      </div>

      {/* Calendar Availability Admin Note */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <span className="text-lg leading-5 flex-shrink-0">📅</span>
          <div>
            <h3 className="text-xs font-bold text-blue-900 uppercase tracking-wide mb-2">Calendar Availability — Admin Note</h3>
            <p className="text-sm text-blue-800 leading-relaxed">
              Availability checks for assigned sales reps depend on <strong>Google Calendar sharing permissions</strong>. If a rep's calendar is not shared with{" "}
              <span className="font-mono text-xs bg-blue-100 px-1 py-0.5 rounded">yaron@ecconstructiongroup.com</span>,
              the system can only check <strong>CRM meetings</strong> for that rep — not their personal Google Calendar events.
            </p>
            <p className="text-xs text-blue-700 mt-2">
              To fix: In Google Workspace admin, ensure each rep shares their calendar with Yaron's account with at least <em>Free/Busy</em> visibility.
              Yaron's own calendar is always fully checked.
            </p>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-3">How It Works</h3>
        <div className="space-y-2.5">
          {[
            { emoji: "🔓", text: "No login required — any agent can open the form without an account" },
            { emoji: "🔍", text: "Automatic duplicate detection — if the phone or email already exists, the lead is updated instead of created" },
            { emoji: "⚡", text: "Leads appear in the CRM immediately after submission" },
            { emoji: "📝", text: "Agent name, email, and submission time are saved in the lead notes automatically" },
            { emoji: "📱", text: "Fully mobile-optimized for tablets and smartphones" },
          ].map(({ emoji, text }, i) => (
            <div key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
              <span className="text-base leading-5">{emoji}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}