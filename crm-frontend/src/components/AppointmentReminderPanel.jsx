import { useState } from 'react';
import { AlertTriangle, Mail, CheckCircle2, Send, Clock } from 'lucide-react';


function fmt12(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AppointmentReminderPanel({ lead }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
  const apptDate = hasFollowUp ? lead.follow_up_date : lead.appointment_date;
  const apptTime = hasFollowUp ? (lead.follow_up_time || '') : (lead.appointment_time || '');
  const apptType = hasFollowUp ? lead.follow_up_type : 'Meeting';

  if (!apptDate) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (apptDate < today) return null;

  const noEmail = !lead.email;
  const dateLabel = formatDate(apptDate);
  const timeLabel = fmt12(apptTime);

  const handleSendNow = async () => {
    setSending(true);
    setResult(null);
    try {
      const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
      const ownerName = lead.assigned_rep || 'EC Construction Group';
      const address = [lead.property_address, lead.city].filter(Boolean).join(', ');
      const subject = `Appointment Reminder — EC Construction Group`;
      const body = `<html><body style="font-family:sans-serif;color:#1a1a2e;padding:24px;">
        <h2 style="color:#0B2D5C;">Upcoming Appointment Reminder</h2>
        <p>Hi ${lead.first_name || 'there'},</p>
        <p>This is a friendly reminder from <strong>${ownerName}</strong> at EC Construction Group about your upcoming ${apptType}.</p>
        <table style="background:#f4f6fa;border-radius:8px;padding:20px;margin:16px 0;width:100%;border-collapse:collapse;">
          ${apptDate ? `<tr><td style="padding:6px 0;font-weight:600;width:140px;">Date</td><td>${dateLabel}</td></tr>` : ''}
          ${timeLabel ? `<tr><td style="padding:6px 0;font-weight:600;">Time</td><td>${timeLabel}</td></tr>` : ''}
          ${address ? `<tr><td style="padding:6px 0;font-weight:600;">Address</td><td>${address}</td></tr>` : ''}
          ${lead.project_type ? `<tr><td style="padding:6px 0;font-weight:600;">Project</td><td>${lead.project_type}</td></tr>` : ''}
        </table>
        <p>If you need to reschedule, please contact us at (310) 310-4108.</p>
        <p>We look forward to seeing you!<br><strong>${ownerName}</strong><br>EC Construction Group</p>
      </body></html>`;

      const recipients = [];
      if (lead.email) recipients.push(lead.email);
      const ownerEmail = (() => { const f = ownerName.trim().split(/\s+/)[0].toLowerCase(); return f ? `${f}@ecconstructiongroup.com` : null; })();
      if (ownerEmail) recipients.push(ownerEmail);
      recipients.push('michelle@ecconstructiongroup.com');
      const uniqRecipients = [...new Set(recipients)];

      const { sendAppointmentReminder } = await import('@/lib/emailTransport');
      const sent = await sendAppointmentReminder({ recipients: uniqRecipients, subject, htmlBody: body, leadId: lead.id, apptDate, apptTime });

      setResult({ success: true, message: `Reminder sent to ${sent} recipient${sent !== 1 ? 's' : ''}.` });
    } catch (e) {
      setResult({ success: false, message: e?.message || String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="px-5 py-3 border-t border-slate-100">
      <p className="sidebar-section-header mb-2">Appointment Reminders</p>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-1.5 min-w-0">
          <Clock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-700 leading-tight">{apptType}</p>
            {(dateLabel || timeLabel) && (
              <p className="text-xs text-slate-500 leading-tight mt-0.5">
                {dateLabel}{timeLabel ? ` · ${timeLabel}` : ''}
              </p>
            )}
          </div>
        </div>
        <button onClick={handleSendNow} disabled={sending} className="sidebar-action-btn flex-shrink-0 mt-0.5">
          <Send className={`w-3 h-3 ${sending ? 'animate-pulse' : ''}`} />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {noEmail && (
        <p className="text-[11px] text-amber-500 mt-1.5 flex items-center gap-1">
          <Mail className="w-3 h-3 flex-shrink-0" /> No customer email — staff only.
        </p>
      )}
      {result && (
        <div className={`flex items-center gap-1.5 mt-1.5 text-[11px] font-medium ${result.success ? 'text-emerald-600' : result.info ? 'text-amber-600' : 'text-red-500'}`}>
          {result.success ? <CheckCircle2 className="w-3 h-3 flex-shrink-0" /> : <AlertTriangle className="w-3 h-3 flex-shrink-0" />}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
}