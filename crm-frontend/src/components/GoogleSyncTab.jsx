import { useState } from "react";
import * as railwayLeads from "@/api/railway/leads";
import { RefreshCw, CheckCircle, AlertCircle, ArrowRight, Users, Calendar, Mail } from "lucide-react";
import { SyncSection, SyncSectionHeader, SyncInfoNotice, SyncStatRow, SyncBtn } from "./SyncCard";
import EmailSyncPanel from "./EmailSyncPanel";

export default function GoogleSyncTab() {
  const [syncing, setSyncing] = useState(null);
  const [lastSync, setLastSync] = useState({});
  const [syncStatus, setSyncStatus] = useState({});

  // Push all CRM leads to Google Contacts via Railway server-side sync
  const handleSyncContacts = async () => {
    setSyncing('contacts');
    setSyncStatus(prev => ({ ...prev, contacts: { status: 'syncing' } }));
    try {
      // Fetch all leads (Railway API doesn't filter by record_type, so filter client-side)
      const resp = await railwayLeads.list({ sort: '-created_date', limit: 500 }).catch(() => ({ items: [] }));
      const leads = resp.items || [];
      const eligible = leads.filter(l => (l.phone || l.email) && (!l.record_type || l.record_type === 'Lead'));

      let created = 0, updated = 0, failed = 0;

      for (const lead of eligible) {
        const externalRef = lead.external_ref || lead.id;
        try {
          const res = await railwayLeads.syncContact(externalRef);
          if (res?.success) {
            if (lead.google_contact_resource_name) { updated++; } else { created++; }
          } else {
            failed++;
          }
        } catch { failed++; }
      }

      setLastSync(prev => ({ ...prev, contacts: new Date().toLocaleTimeString() }));
      setSyncStatus(prev => ({ ...prev, contacts: { status: 'success', total_leads: eligible.length, created, updated, failed, skipped: leads.length - eligible.length } }));
    } catch (e) {
      setSyncStatus(prev => ({ ...prev, contacts: { status: 'error', message: e?.message || 'Unknown error' } }));
    }
    setSyncing(null);
  };

  // Push all CRM appointments to Google Calendar via Railway server-side sync
  const handleSyncCalendar = async () => {
    setSyncing('calendar');
    setSyncStatus(prev => ({ ...prev, calendar: { status: 'syncing' } }));
    try {
      const today = new Date().toISOString().slice(0, 10);
      // Railway API doesn't filter by follow_up_type, so filter client-side
      const resp = await railwayLeads.list({ sort: '-follow_up_date', limit: 200 }).catch(() => ({ items: [] }));
      const leads = resp.items || [];
      const future = leads.filter(l => l.follow_up_type === 'Meeting' && l.follow_up_date && l.follow_up_date >= today && !l.google_event_id);

      let synced = 0, skipped = 0, errors = 0;

      for (const lead of future) {
        const externalRef = lead.external_ref || lead.id;
        try {
          const res = await railwayLeads.syncCalendar(externalRef);
          if (res?.success) {
            synced++;
          } else {
            errors++;
          }
        } catch { errors++; }
      }

      skipped = leads.length - future.length;
      setLastSync(prev => ({ ...prev, calendar: new Date().toLocaleTimeString() }));
      setSyncStatus(prev => ({ ...prev, calendar: { status: 'success', total: leads.length, created: synced, skipped, errors } }));
    } catch (e) {
      setSyncStatus(prev => ({ ...prev, calendar: { status: 'error', message: e?.message || 'Unknown error' } }));
    }
    setSyncing(null);
  };

  const cs = syncStatus.contacts;
  const cal = syncStatus.calendar;

  return (
    <div className="max-w-2xl space-y-4">

      {/* ── Architecture notice ── */}
      <SyncSection>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs font-semibold text-slate-600">One-way sync:</span>
          <div className="flex items-center gap-2 text-xs font-semibold">
            <span className="bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full">ContractorFlow</span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
            <span className="bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">Google Contacts</span>
            <span className="text-slate-400">·</span>
            <span className="bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">Google Calendar</span>
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          All changes originate in ContractorFlow and flow outward to Google via direct Google API.
        </p>
      </SyncSection>

      {/* ── Google Contacts ── */}
      <SyncSection>
        <SyncSectionHeader
          icon={Users}
          title="Google Contacts"
          iconColor="text-emerald-500"
          badge={{ label: "Direct Google API", className: "bg-emerald-100 text-emerald-700" }}
          action={
            <SyncBtn onClick={handleSyncContacts} disabled={!!syncing} loading={syncing === 'contacts'} icon={RefreshCw}>
              {syncing === 'contacts' ? 'Syncing...' : 'Push to Google'}
            </SyncBtn>
          }
        />
        <p className="text-xs text-slate-500 mb-3">
          Pushes CRM leads to Google Contacts using the connected Google Contacts OAuth account.
        </p>

        {lastSync.contacts && <p className="text-[10px] text-slate-400 mb-2">Last synced: {lastSync.contacts}</p>}

        {cs?.status === 'success' && (
          <SyncInfoNotice variant="green">
            <div className="flex items-center gap-2 font-semibold mb-2"><CheckCircle className="w-3.5 h-3.5" /> Sync complete</div>
            <SyncStatRow items={[
              { label: "Eligible", value: cs.total_leads, color: "slate" },
              { label: "Created", value: cs.created, color: "green" },
              { label: "Updated", value: cs.updated, color: "blue" },
              { label: "Skipped", value: cs.skipped ?? 0, color: "slate" },
              { label: "Failed", value: cs.failed, color: cs.failed > 0 ? "red" : "slate" },
            ]} />
          </SyncInfoNotice>
        )}
        {cs?.status === 'error' && (
          <SyncInfoNotice variant="red">
            <div className="flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" /><span className="font-semibold">Sync failed</span></div>
            <div className="font-mono text-[10px] mt-1 break-words">{cs.message}</div>
          </SyncInfoNotice>
        )}
      </SyncSection>

      {/* ── Google Calendar ── */}
      <SyncSection>
        <SyncSectionHeader
          icon={Calendar}
          title="Google Calendar"
          iconColor="text-blue-500"
          badge={{ label: "CRM → Google", className: "bg-blue-100 text-blue-700" }}
          action={
            <SyncBtn onClick={handleSyncCalendar} disabled={!!syncing} loading={syncing === 'calendar'} icon={RefreshCw}>
              {syncing === 'calendar' ? 'Syncing...' : 'Push to Google'}
            </SyncBtn>
          }
        />
        <p className="text-xs text-slate-500 mb-3">
          Pushes lead meetings to Google Calendar. Uses the connected Google Calendar OAuth account.
        </p>
        {lastSync.calendar && <p className="text-[10px] text-slate-400 mb-2">Last synced: {lastSync.calendar}</p>}
        {cal?.status === 'success' && (
          <SyncInfoNotice variant="green">
            <div className="flex items-center gap-2 font-semibold mb-2"><CheckCircle className="w-3.5 h-3.5" /> Sync complete</div>
            <SyncStatRow items={[
              { label: "Checked", value: cal.total, color: "slate" },
              { label: "Created", value: cal.created, color: "green" },
              { label: "Already synced", value: cal.skipped, color: "slate" },
              { label: "Failed", value: cal.errors, color: cal.errors > 0 ? "red" : "slate" },
            ]} />
          </SyncInfoNotice>
        )}
        {cal?.status === 'error' && (
          <SyncInfoNotice variant="red">
            <div className="flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" /><span className="font-semibold">Sync failed</span></div>
            <div className="font-mono text-[10px] mt-1 break-words">{cal.message}</div>
          </SyncInfoNotice>
        )}
      </SyncSection>

      {/* ── Gmail / Email Sync ── */}
      <EmailSyncPanel />

      {/* ── Sync rules info ── */}
      <SyncInfoNotice variant="neutral">
        <p className="font-semibold text-slate-700 mb-1.5">Outbound Sync Rules</p>
        <ul className="space-y-1 text-slate-500">
          <li>• Contacts matched by stored Google resource name to prevent duplicates</li>
          <li>• All sync is ContractorFlow → Google only (no inbound writes)</li>
          <li>• Appointments sync automatically via the FollowUp Scheduler</li>
          <li>• Use "Push to Google" for a full batch re-sync</li>
        </ul>
      </SyncInfoNotice>
    </div>
  );
}