import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Send, AlertTriangle, ShieldOff, Clock, ShieldCheck, Pencil } from 'lucide-react';
import { sms as railwaySms, leads as railwayLeads } from '@/api/railway';
import { fmtDateTime } from '@/lib/formatters';

const ERROR_LABELS = {
  no_phone: 'This lead has no phone number on file.',
  invalid_phone: 'This lead’s phone number is not a valid 10-digit US number.',
  recipient_opted_out: 'This phone number has opted out of SMS (replied STOP) and cannot be messaged.',
  no_consent: 'This lead has not given SMS consent. Enable SMS consent before sending.',
  quiet_hours: 'Outbound SMS is restricted during quiet hours. Try again later.',
  twilio_not_configured: 'SMS is not yet configured for this installation.',
};

/**
 * Lead Detail SMS panel — two-way Twilio conversation for one lead.
 * Mirrors AppointmentReminderPanel.jsx's compact sidebar styling. Every
 * send-time rejection (consent/opt-out/quiet-hours/not-configured) is
 * surfaced with its own clear message — never a generic failure — so a rep
 * understands WHY a message didn't go out.
 */
export default function SmsPanel({ lead, onLeadUpdate }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const threadRef = useRef(null);

  // ── SMS consent: visibility + an authorized later change ────────────────
  // The server (routes/leads.js's PUT /:id/sms-consent, reusing the SAME
  // resolveOwnerScope ownership check every other lead write already uses)
  // is the real authorization boundary — this UI is shown unconditionally,
  // same convention as the compose box above/below it.
  const [consentEditOpen, setConsentEditOpen] = useState(false);
  const [consentAction, setConsentAction] = useState('grant'); // 'grant' | 'revoke'
  const [evidenceNote, setEvidenceNote] = useState('');
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState(null);

  const openConsentEdit = (action) => {
    setConsentAction(action);
    setEvidenceNote('');
    setConsentError(null);
    setConsentEditOpen(true);
  };

  const submitConsentChange = async () => {
    setConsentSaving(true);
    setConsentError(null);
    try {
      const res = await railwayLeads.updateSmsConsent(lead.id, {
        confirmed: consentAction === 'grant',
        evidence_note: evidenceNote.trim() || null,
      });
      setConsentEditOpen(false);
      if (typeof onLeadUpdate === 'function' && res?.lead) onLeadUpdate(res.lead);
    } catch (e) {
      const code = e?.data?.error;
      setConsentError(
        code === 'recipient_opted_out'
          ? 'This number has opted out (replied STOP) and cannot be re-consented — ask the customer to reply START first.'
          : e?.message || 'Could not save consent change.'
      );
    } finally {
      setConsentSaving(false);
    }
  };

  const load = useCallback(async () => {
    if (!lead?.id) return;
    try {
      const res = await railwaySms.getConversation(lead.id);
      setMessages(res?.items || []);
    } catch {
      // History failing to load is non-fatal — the compose box still works.
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  if (!lead?.phone) return null;

  const handleSend = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const res = await railwaySms.send(lead.id, body);
      setMessages((prev) => [...prev, res.message]);
      setDraft('');
    } catch (e) {
      const code = e?.data?.error;
      setError(ERROR_LABELS[code] || e?.message || 'Could not send message.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="px-5 py-3 border-t border-slate-100">
      <p className="sidebar-section-header mb-2 flex items-center gap-1.5">
        <MessageSquare className="w-3.5 h-3.5 text-slate-400" /> SMS
      </p>

      {lead.sms_consent === true ? (
        <div className="flex items-start justify-between gap-2 mb-2 text-[11px] text-emerald-700">
          <div className="flex items-start gap-1.5">
            <ShieldCheck className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>
              SMS consent on file{lead.sms_consent_at ? ` · ${fmtDateTime(lead.sms_consent_at)}` : ''}
              {lead.sms_consent_source ? ` · ${lead.sms_consent_source}` : ''}
              {lead.sms_consent_recorded_by ? ` · recorded by ${lead.sms_consent_recorded_by}` : ''}
            </span>
          </div>
          <button onClick={() => openConsentEdit('revoke')} className="flex items-center gap-1 text-slate-500 hover:text-slate-700 flex-shrink-0">
            <Pencil className="w-3 h-3" /> Change
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 mb-2 text-[11px] text-amber-600">
          <div className="flex items-center gap-1.5">
            <ShieldOff className="w-3 h-3 flex-shrink-0" />
            <span>No SMS consent on file — sending is blocked until consent is recorded.</span>
          </div>
          <button onClick={() => openConsentEdit('grant')} className="flex items-center gap-1 text-amber-700 hover:text-amber-900 font-semibold flex-shrink-0">
            <Pencil className="w-3 h-3" /> Record
          </button>
        </div>
      )}

      {consentEditOpen && (
        <div className="mb-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50 space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-700">
            {consentAction === 'grant' ? 'Record SMS consent' : 'Revoke SMS consent'}
          </p>
          <p className="text-[10px] text-slate-500">
            {consentAction === 'grant'
              ? 'Confirm the customer has given affirmative consent (verbal or written) to receive appointment-related SMS. A STOP opt-out on file can never be overridden here.'
              : 'This stops all future appointment-related SMS to this lead until consent is recorded again.'}
          </p>
          <textarea
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            placeholder="Evidence / notes (optional)…"
            rows={2}
            maxLength={2000}
            className="w-full text-xs rounded-lg border border-slate-200 px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          {consentError && (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-red-500">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" /> <span>{consentError}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <button
              onClick={submitConsentChange}
              disabled={consentSaving}
              className={`sidebar-action-btn flex-shrink-0 ${consentAction === 'revoke' ? '!bg-red-600 hover:!bg-red-700' : ''}`}
            >
              {consentSaving ? 'Saving…' : consentAction === 'grant' ? 'Confirm consent' : 'Confirm revoke'}
            </button>
            <button onClick={() => setConsentEditOpen(false)} className="text-[11px] font-semibold text-slate-500 hover:text-slate-700">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!loading && messages.length > 0 && (
        <div ref={threadRef} className="max-h-48 overflow-y-auto space-y-1.5 mb-2 pr-1">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs ${
                m.direction === 'outbound' ? 'bg-amber-50 text-slate-800' : 'bg-slate-100 text-slate-800'
              }`}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" /> {fmtDateTime(m.created_at)}
                  {m.direction === 'outbound' && m.status === 'failed' && <span className="text-red-500 font-semibold">· failed</span>}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          rows={2}
          maxLength={1600}
          className="flex-1 text-xs rounded-lg border border-slate-200 px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <button onClick={handleSend} disabled={sending || !draft.trim()} className="sidebar-action-btn flex-shrink-0">
          <Send className={`w-3 h-3 ${sending ? 'animate-pulse' : ''}`} />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] font-medium text-red-500">
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
