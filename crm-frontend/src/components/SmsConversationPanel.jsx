import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, AlertTriangle, ShieldOff, ShieldCheck, Pencil, Clock, CheckCheck, XCircle } from 'lucide-react';
import { sms as railwaySms, leads as railwayLeads } from '@/api/railway';
import { fmtDateTime } from '@/lib/formatters';
import { smsAuthorLabel } from '@/lib/smsActivityAdapter';

const ERROR_LABELS = {
  no_phone: 'This lead has no phone number on file.',
  invalid_phone: 'This lead’s phone number is not a valid 10-digit US number.',
  recipient_opted_out: 'This phone number has opted out of SMS (replied STOP) and cannot be messaged.',
  no_consent: 'This lead has not given SMS consent. Record consent above before sending.',
  quiet_hours: 'Outbound SMS is restricted during quiet hours. Try again later.',
  twilio_not_configured: 'SMS is not yet configured for this installation.',
  unexpected_error: 'Something went wrong sending this message. Please try again, or contact support if it keeps happening.',
};

// Delivery-status badge — every outbound/inbound row gets one, covering the
// full Twilio status vocabulary this installation can receive (see
// lib/smsService.js#KNOWN_SMS_STATUSES / db/migrations/
// 2026-65-sms-messages-status-check-widen.sql): accepted/queued/sending are
// all pre-delivery in-flight states shown identically to "Queued" — a rep
// doesn't need to distinguish them, just that nothing has failed yet.
const STATUS_BADGE = {
  accepted: { label: 'Queued', cls: 'text-slate-400' },
  queued: { label: 'Queued', cls: 'text-slate-400' },
  sending: { label: 'Queued', cls: 'text-slate-400' },
  sent: { label: 'Sent', cls: 'text-slate-400' },
  delivered: { label: 'Delivered', cls: 'text-emerald-600' },
  failed: { label: 'Failed', cls: 'text-red-500 font-semibold' },
  undelivered: { label: 'Undelivered', cls: 'text-red-500 font-semibold' },
  canceled: { label: 'Canceled', cls: 'text-red-500 font-semibold' },
  receiving: { label: 'Received', cls: 'text-slate-400' },
  received: { label: 'Received', cls: 'text-slate-400' },
};

// How often to re-poll the conversation while this tab/panel is mounted, so
// an inbound customer reply (and a delivery-status transition on a message
// already sent) appears without the rep manually refreshing the page. This
// codebase has no push/websocket channel to the frontend today — polling is
// the smallest change that satisfies "without manual refresh where
// technically feasible" without inventing new server infrastructure.
const POLL_MS = 12000;

/**
 * SmsConversationPanel — the full two-way Twilio conversation for one lead:
 * consent status + an authorized grant/revoke control (PR #40), the message
 * thread (manual sends, automated confirmation/12h/2h reminders, customer
 * replies — distinguished via lib/smsActivityAdapter#smsAuthorLabel, with
 * full delivery-status + error display), and the compose box. Lives inside
 * the central "Text Message" tab of ActivityComposer.jsx — this is now the
 * ONE place this UI exists; the old left-sidebar SmsPanel.jsx was removed
 * once this replaced it everywhere.
 */
export default function SmsConversationPanel({ lead, onLeadUpdate }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const threadRef = useRef(null);

  // ── SMS consent: visibility + an authorized later change (PR #40) ───────
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
    // No phone on file -> the no-phone state below renders instead of a
    // conversation; never fetch/poll in that case (hooks must run
    // unconditionally, so this guard lives in the callback, not a
    // conditional effect).
    if (!lead?.id || !lead?.phone) { setLoading(false); return; }
    try {
      const res = await railwaySms.getConversation(lead.id);
      setMessages(res?.items || []);
    } catch {
      // History failing to load is non-fatal — the compose box still works.
    } finally {
      setLoading(false);
    }
  }, [lead?.id, lead?.phone]);

  useEffect(() => { load(); }, [load]);

  // Polling for near-real-time inbound replies / status transitions (see
  // POLL_MS comment above). Cleared on unmount or lead change.
  useEffect(() => {
    if (!lead?.id || !lead?.phone) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [lead?.id, lead?.phone, load]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

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

  if (!lead?.phone) {
    return (
      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-xs text-amber-700 font-semibold mb-1">No phone number on file for this lead</p>
          <p className="text-[10px] text-amber-600">Add a phone number before sending or receiving text messages.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {lead.sms_consent === true ? (
        <div className="flex items-start justify-between gap-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <div className="flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
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
        <div className="flex items-center justify-between gap-2 text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <div className="flex items-center gap-1.5">
            <ShieldOff className="w-3.5 h-3.5 flex-shrink-0" />
            <span>No SMS consent on file — sending is blocked until consent is recorded.</span>
          </div>
          <button onClick={() => openConsentEdit('grant')} className="flex items-center gap-1 text-amber-700 hover:text-amber-900 font-semibold flex-shrink-0">
            <Pencil className="w-3 h-3" /> Record
          </button>
        </div>
      )}

      {consentEditOpen && (
        <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 space-y-1.5">
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

      {!loading && (
        <div ref={threadRef} className="max-h-96 overflow-y-auto space-y-2 pr-1 border border-slate-100 rounded-lg p-3 bg-slate-50/50">
          {messages.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">No text messages yet.</p>
          ) : messages.map((m) => {
            const badge = STATUS_BADGE[m.status] || null;
            return (
              <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs ${
                  m.direction === 'outbound' ? 'bg-blue-50 text-slate-800 border border-blue-100' : 'bg-white text-slate-800 border border-slate-200'
                }`}>
                  <p className="text-[10px] font-semibold text-slate-500 mb-0.5">{smsAuthorLabel(m)}</p>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                    <Clock className="w-2.5 h-2.5" /> {fmtDateTime(m.created_at)}
                    {m.direction === 'outbound' && badge && (
                      <span className={`inline-flex items-center gap-0.5 ${badge.cls}`}>
                        {m.status === 'delivered' ? <CheckCheck className="w-2.5 h-2.5" /> : (m.status === 'failed' || m.status === 'undelivered') ? <XCircle className="w-2.5 h-2.5" /> : null}
                        {badge.label}
                      </span>
                    )}
                    {m.keyword && <span className="font-semibold text-slate-500">· {m.keyword}</span>}
                  </p>
                  {(m.status === 'failed' || m.status === 'undelivered') && m.error_message && (
                    <p className="text-[10px] text-red-500 mt-0.5">{m.error_message}{m.error_code ? ` (${m.error_code})` : ''}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a text message…"
          rows={2}
          maxLength={1600}
          className="flex-1 text-sm rounded-lg border border-slate-200 px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
        <button
          onClick={handleSend}
          disabled={sending || !draft.trim()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        >
          <Send className={`w-3.5 h-3.5 ${sending ? 'animate-pulse' : ''}`} />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-red-500">
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

