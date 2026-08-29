/**
 * FollowUpReminderPopup
 *
 * Renders a stacked popup for each due follow-up in the reminder queue.
 * Shows: lead name, phone, type, time, and action buttons.
 */
import { useNavigate } from 'react-router-dom';
import { Phone, Calendar, X, Clock, CheckCircle, ExternalLink } from 'lucide-react';
import { useFollowUpReminders } from '@/hooks/useFollowUpReminders';

function fmt12(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return 'Today';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const SNOOZE_OPTIONS = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
];

function ReminderCard({ reminder, onSnooze, onMarkDone, onDismiss }) {
  const navigate = useNavigate();
  const { lead, key, type } = reminder;
  const isCall = type === 'Phone Call';
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();

  return (
    <div className={`w-full max-w-sm rounded-2xl shadow-2xl border-2 overflow-hidden bg-white animate-slide-up
      ${isCall ? 'border-green-400' : 'border-blue-400'}`}
    >
      {/* Header */}
      <div className={`px-5 py-3 flex items-center justify-between ${isCall ? 'bg-green-600' : 'bg-blue-600'}`}>
        <div className="flex items-center gap-2 text-white">
          {isCall
            ? <Phone className="w-4 h-4" />
            : <Calendar className="w-4 h-4" />
          }
          <span className="text-sm font-bold uppercase tracking-wide">
            {isCall ? 'Phone Call' : 'Meeting'} Reminder
          </span>
        </div>
        <button
          onClick={() => onDismiss(key)}
          className="text-white/70 hover:text-white transition-colors p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-3">
        <div>
          <p className="text-lg font-black text-slate-900">{name}</p>
          <p className={`text-sm font-bold ${isCall ? 'text-green-700' : 'text-blue-700'}`}>
            {formatDate(lead.follow_up_date)} · {fmt12(lead.follow_up_time)}
          </p>
        </div>

        {lead.phone && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Phone className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <span className="font-semibold">{lead.phone}</span>
          </div>
        )}

        {lead.project_type && (
          <div className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-1.5">
            {lead.project_type}{lead.city ? ` · ${lead.city}` : ''}
          </div>
        )}

        {/* Primary Actions */}
        <div className="flex gap-2 pt-1">
          {isCall && lead.phone && (
            <a
              href={`tel:${lead.phone}`}
              className="flex-1 flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold py-2.5 rounded-xl transition-colors active:scale-95"
            >
              <Phone className="w-4 h-4" /> Call
            </a>
          )}
          <button
            onClick={() => { navigate(`/leads/${lead.id}`); onDismiss(key); }}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-900 text-white text-sm font-bold py-2.5 rounded-xl transition-colors active:scale-95"
          >
            <ExternalLink className="w-4 h-4" /> Open Lead
          </button>
        </div>

        {/* Snooze */}
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          <span className="text-xs text-slate-500 font-semibold mr-1">Snooze:</span>
          {SNOOZE_OPTIONS.map(opt => (
            <button
              key={opt.minutes}
              onClick={() => onSnooze(key, opt.minutes)}
              className="flex-1 text-xs font-semibold px-2 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-amber-50 hover:border-amber-400 hover:text-amber-700 transition-colors"
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Mark Done */}
        <button
          onClick={() => onMarkDone(key, lead.id, lead.follow_up_date, lead.follow_up_time)}
          className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 py-2 rounded-xl transition-colors"
        >
          <CheckCircle className="w-4 h-4" /> Mark Done — clear follow-up
        </button>
      </div>
    </div>
  );
}

export default function FollowUpReminderPopup() {
  const { queue, snooze, markDone, dismiss } = useFollowUpReminders();

  if (queue.length === 0) return null;

  // Stack up to 3 at once, newest on top
  const visible = queue.slice(0, 3);

  return (
    <div
      className="fixed bottom-6 right-4 z-[9999] flex flex-col gap-3 items-end"
      style={{ maxWidth: '100vw' }}
    >
      {visible.map(reminder => (
        <ReminderCard
          key={reminder.key}
          reminder={reminder}
          onSnooze={snooze}
          onMarkDone={markDone}
          onDismiss={dismiss}
        />
      ))}
      {queue.length > 3 && (
        <div className="text-xs font-semibold text-slate-500 bg-white border border-slate-200 rounded-full px-3 py-1.5 shadow-sm">
          +{queue.length - 3} more reminders
        </div>
      )}
    </div>
  );
}