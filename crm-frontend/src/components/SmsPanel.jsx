import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Send, AlertTriangle, ShieldOff, Clock } from 'lucide-react';
import { sms as railwaySms } from '@/api/railway';
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
export default function SmsPanel({ lead }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const threadRef = useRef(null);

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

      {lead.sms_consent !== true && (
        <div className="flex items-center gap-1.5 mb-2 text-[11px] text-amber-600">
          <ShieldOff className="w-3 h-3 flex-shrink-0" />
          <span>No SMS consent on file — sending is blocked until consent is recorded.</span>
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
