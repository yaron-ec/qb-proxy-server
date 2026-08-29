import React, { useState } from 'react';
import { leads as railwayLeads } from '@/api/railway';
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Loader2, Calendar, User } from 'lucide-react';

// Syncs via the Railway backend (service account — no token exposed to client)
async function syncLeadCalendar(lead) {
  try {
    const data = await railwayLeads.syncCalendar(lead.id);
    if (data?.success === false) {
      return { error: data?.error || 'Sync failed' };
    }
    return { success: true, already_exists: !!data?.already_existed };
  } catch (e) {
    return { error: e.message || 'Sync failed' };
  }
}

// Module-level in-flight guard — keyed by lead ID so no two requests fire simultaneously
const inFlight = new Set();

export default function CalendarSyncPanel({ lead }) {
  const [queueRecord, setQueueRecord] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState(null);

  const isMeeting = lead.follow_up_type === 'Meeting';
  const hasDate = !!(lead.appointment_date || lead.follow_up_date);
  if (!isMeeting || !hasDate) return null;

  const syncStatus = lead.google_calendar_sync_status;
  const syncError = lead.google_calendar_sync_error;
  const hasEvent = !!lead.google_event_id;
  const hasBuffer = !!lead.google_travel_event_id;
  const isFailed = syncStatus === 'error' || syncStatus === 'failed';
  const isPending = syncStatus === 'pending' || queueRecord?.status === 'pending';
  const isSynced = syncStatus === 'synced' && hasEvent;

  // Rep name for display
  const repFirstName = (lead.assigned_rep || '').trim().split(/\s+/)[0] || 'Rep';

  const handleRetry = async () => {
    // Strict in-flight guard: ignore any click while a request is already in progress for this lead
    if (inFlight.has(lead.id) || retrying) return;
    inFlight.add(lead.id);
    setRetrying(true);
    setRetryMsg(null);
    try {
      const data = await syncLeadCalendar(lead);
      if (data?.success) {
        const msg = data?.already_exists ? '✓ Calendar event already exists' : '✓ Calendar event synced successfully';
        setRetryMsg({ type: 'success', text: msg });
      } else {
        setRetryMsg({ type: 'error', text: data?.error || 'Sync failed' });
      }
    } catch (e) {
      setRetryMsg({ type: 'error', text: e.message });
    } finally {
      inFlight.delete(lead.id);
      setRetrying(false);
    }
  };

  // ── Status row helper ──
  const StatusRow = ({ icon, label, status }) => {
    const ok = status === 'synced';
    const failed = status === 'error' || status === 'failed';
    const pending = status === 'pending';
    return (
      <div className="flex items-center gap-1.5">
        {ok ? <CheckCircle className="w-3 h-3 text-emerald-500 flex-shrink-0" />
          : pending ? <Clock className="w-3 h-3 text-amber-400 flex-shrink-0" />
          : <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" />}
        {icon}
        <span className={`text-[11px] ${ok ? 'text-slate-600' : pending ? 'text-amber-600' : 'text-red-500'}`}>
          {ok ? `Synced to ${label}` : pending ? `Syncing to ${label}…` : `Failed: ${label}`}
        </span>
      </div>
    );
  };

  return (
    <div className="px-5 py-3 border-t border-slate-100">
      <p className="sidebar-section-header mb-2">Calendar Sync</p>

      {isSynced ? (
        <div className="space-y-1.5">
          <StatusRow icon={<Calendar className="w-3 h-3 text-slate-400 flex-shrink-0" />} label="Yaron calendar" status="synced" />
          <StatusRow icon={<User className="w-3 h-3 text-slate-400 flex-shrink-0" />} label={`${repFirstName} calendar`} status="synced" />
          {!hasBuffer && (
            <p className="text-[10px] text-amber-500 pl-5">Travel block missing</p>
          )}
        </div>
      ) : isPending ? (
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="text-xs text-amber-600">Sync pending…</span>
        </div>
      ) : isFailed ? (
        <div className="space-y-1.5">
          <StatusRow icon={<Calendar className="w-3 h-3 text-slate-400 flex-shrink-0" />} label="Yaron calendar" status="error" />
          <StatusRow icon={<User className="w-3 h-3 text-slate-400 flex-shrink-0" />} label={`${repFirstName} calendar`} status="error" />
          {syncError && (
            <p className="text-[11px] text-red-500 pl-5 leading-snug break-words">{syncError}</p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="text-xs text-slate-500">Event not yet created</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-2">
        {isSynced && lead.last_google_sync && (
          <p className="text-[11px] text-slate-400">
            Last synced {new Date(lead.last_google_sync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
        {!isSynced && (
          <button onClick={handleRetry} disabled={retrying} className="sidebar-action-btn ml-auto">
            {retrying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {retrying ? 'Syncing…' : isFailed ? 'Retry' : 'Create'}
          </button>
        )}
      </div>

      {retryMsg && (
        <p className={`text-[11px] mt-1.5 font-medium ${retryMsg.type === 'success' ? 'text-emerald-600' : 'text-red-500'}`}>
          {retryMsg.text}
        </p>
      )}
    </div>
  );
}