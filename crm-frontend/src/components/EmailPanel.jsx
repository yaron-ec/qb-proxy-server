import { useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { Send, RefreshCw, Mail, ExternalLink } from "lucide-react";

export default function EmailPanel({ lead }) {
  const [emails, setEmails] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  // Compose
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sentSuccess, setSentSuccess] = useState(false);
  // Stable idempotency id per compose action: generated when the user opens
  // the compose form, reused for retries of that same send, regenerated on
  // the next compose open. Passed to the transport adapter so retries and
  // overlapping calls deduplicate against the server claim.
  const [clientRequestId, setClientRequestId] = useState("");

  const fetchEmails = async () => {
    setFetching(true);
    try {
      const data = await railwayRequest('/gmail/fetch-emails', { leadEmail: lead.email });
      setEmails(data?.emails || []);
    } catch {
      setEmails([]);
    }
    setHasFetched(true);
    setFetching(false);
  };

  const sendEmail = async () => {
    if (!subject.trim() || !emailBody.trim()) return;
    setSending(true);
    const { sendGenericEmail } = await import('@/lib/emailTransport');
    await sendGenericEmail({ to: lead.email, subject, htmlBody: emailBody, leadId: lead.id, clientRequestId }).catch(() => {});
    setSentSuccess(true);
    setSending(false);
    setTimeout(() => {
      setComposing(false);
      setSentSuccess(false);
      setSubject("");
      setEmailBody("");
      fetchEmails();
    }, 1500);
  };

  return (
    <div className="p-4 space-y-3">
      {/* Compose button */}
      <button
        onClick={() => {
          setComposing(v => { if (!v) setClientRequestId(crypto.randomUUID()); return !v; });
        }}
        className="w-full flex items-center justify-center gap-2 bg-orange text-white px-3 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors"
      >
        <Send className="w-3.5 h-3.5" />
        {composing ? "Cancel" : `Send Email to ${lead.first_name}`}
      </button>

      {/* Compose form */}
      {composing && (
        <div className="border border-slate-200 rounded p-3 space-y-2 bg-slate-50">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            To: {lead.email}
          </div>
          <input
            type="text"
            placeholder="Subject *"
            className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400 bg-white"
            value={subject}
            onChange={e => setSubject(e.target.value)}
          />
          <textarea
            placeholder="Message *"
            rows={5}
            className="w-full border border-slate-200 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400 bg-white"
            value={emailBody}
            onChange={e => setEmailBody(e.target.value)}
          />
          <button
            onClick={sendEmail}
            disabled={sending || sentSuccess || !subject.trim() || !emailBody.trim()}
            className="w-full flex items-center justify-center gap-2 bg-orange text-white px-3 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors disabled:opacity-50"
          >
            {sentSuccess ? (
              "✓ Sent!"
            ) : sending ? (
              <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Sending...</>
            ) : (
              <><Send className="w-3 h-3" />Send</>
            )}
          </button>
        </div>
      )}

      {/* Fetch button */}
      <button
        onClick={fetchEmails}
        disabled={fetching}
        className="w-full flex items-center justify-center gap-2 border border-slate-200 text-slate-600 px-3 py-2 text-xs font-bold rounded hover:bg-slate-50 transition-colors disabled:opacity-50"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${fetching ? "animate-spin" : ""}`} />
        {hasFetched ? "Refresh Emails" : "Load Emails from Gmail"}
      </button>

      {/* Email list */}
      {hasFetched && (
        emails.length === 0 ? (
          <div className="py-6 text-center text-slate-400 text-xs">
            <Mail className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            No emails found with {lead.email}
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {emails.map((email) => (
              <div key={email.id} className="border border-slate-200 rounded p-3 text-xs hover:bg-slate-50 transition-colors">
                <div className="font-semibold text-slate-800 truncate">{email.subject}</div>
                <div className="text-[10px] text-slate-500 mt-0.5 truncate">{email.from}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {email.date ? new Date(email.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                </div>
                {email.snippet && (
                  <div className="text-slate-500 mt-1.5 line-clamp-2 leading-relaxed">{email.snippet}</div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      <a
        href="https://mail.google.com"
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-1.5 w-full text-center text-slate-400 text-[10px] font-semibold hover:text-slate-600 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />Open Gmail
      </a>
    </div>
  );
}