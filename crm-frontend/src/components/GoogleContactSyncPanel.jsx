import { useState } from 'react';
import { leads as railwayLeads } from '@/api/railway';
import { Contact, CheckCircle2, AlertTriangle, Clock, RefreshCw } from 'lucide-react';

export default function GoogleContactSyncPanel({ lead, onLeadUpdate }) {
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  if (!lead.phone && !lead.email) return null;

  const status = lead.google_contact_sync_status;
  const synced = !!lead.google_contact_resource_name && status === 'synced';

  const handleSync = async () => {
    setSyncing(true);
    setToast(null);
    try {
      const res = await railwayLeads.syncContact(lead.id);
      if (res?.success === false) {
        const errMsg = res?.error || 'Sync failed';
        setToast({ type: 'error', msg: errMsg });
        return;
      }
      // Refresh lead to get updated sync status
      const updated = await railwayLeads.getByExternal(lead.id);
      onLeadUpdate?.(updated?.lead);
      setToast({ type: 'success', msg: res?.status === 'pending' ? 'Contact marked for sync' : 'Contact Synced' });
    } catch (e) {
      const errMsg = e?.response?.data?.message || e?.message || String(e);
      setToast({ type: 'error', msg: errMsg });
    } finally {
      setSyncing(false);
    }
  };

  const StatusIcon = synced ? CheckCircle2 : status === 'pending' ? Clock : status === 'error' ? AlertTriangle : Contact;
  const statusText = synced ? 'Synced to Google Contacts' : status === 'pending' ? 'Sync pending…' : status === 'error' ? 'Sync failed' : 'Not synced yet';
  const statusColor = synced ? 'text-emerald-600' : status === 'error' ? 'text-red-500' : 'text-slate-400';

  return (
    <div className="px-5 py-3 border-t border-slate-100">
      <p className="sidebar-section-header mb-2">Google Contacts</p>
      <div className="flex items-center justify-between gap-3">
        <div className={`flex items-center gap-1.5 min-w-0 ${statusColor}`}>
          <StatusIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="text-xs text-slate-600">{statusText}</span>
        </div>
        <button onClick={handleSync} disabled={syncing} className="sidebar-action-btn">
          <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : synced ? 'Re-sync' : 'Sync Now'}
        </button>
      </div>
      {status === 'error' && lead.google_contact_sync_error && (
        <p className="text-[11px] text-red-500 mt-1.5 leading-snug">{lead.google_contact_sync_error}</p>
      )}
      {toast && (
        <p className={`text-[11px] mt-1.5 ${toast.type === 'error' ? 'text-red-500' : toast.type === 'info' ? 'text-amber-600' : 'text-emerald-600'}`}>
          {toast.type === 'error' ? '⚠ ' : toast.type === 'info' ? 'ℹ ' : '✓ '}{toast.msg}
        </p>
      )}
    </div>
  );
}