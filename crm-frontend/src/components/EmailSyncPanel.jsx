import { useState, useEffect } from 'react';
import * as railwayApi from '@/lib/railwayApi';
import * as railwayLeads from '@/api/railway/leads';
import * as railwayActivities from '@/api/railway/activities';
import { Mail, Loader2, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { SyncSection, SyncSectionHeader } from './SyncCard';

/**
 * Gmail / Email Sync — Railway-owned Gmail READ.
 *
 * All Gmail API calls are made SERVER-SIDE via /api/v1/gmail/* (Railway holds
 * the Gmail OAuth token; it is never returned to the browser). This component
 * no longer constructs `Authorization: Bearer <gmail token>` headers.
 */
export default function EmailSyncPanel() {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    setStatus(null);
    try {
      if (!railwayApi.isLoggedIn()) {
        setStatus({ connected: false, reason: 'Railway session not active. Sign in to sync Gmail.' });
        return;
      }
      const profile = await railwayApi.gmailProfile();
      setStatus({ connected: true, email: profile.emailAddress });
    } catch (e) {
      const msg = e?.message || 'Could not check Gmail connection.';
      setStatus({ connected: false, reason: /401|credentials|token/i.test(msg) ? 'Gmail token expired on the server. Reconnect the Gmail integration.' : msg });
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      if (!railwayApi.isLoggedIn()) throw new Error('Railway session not active');

      const list = await railwayApi.gmailMessages(50, 'is:inbox');
      const messages = list.messages || [];

      const leads = await railwayLeads.list({ sort: '-created_date', limit: 500 }).then(r => r.items || []).catch(() => []);
      const emailToLead = {};
      for (const lead of leads) {
        if (lead.email) emailToLead[lead.email.toLowerCase()] = lead;
      }

      let matched = 0;
      const extractEmail = (str) => { const m = String(str || '').match(/[\w.+-]+@[\w-]+\.\w+/); return m ? m[0].toLowerCase() : null; };

      for (const msg of messages.slice(0, 20)) {
        const fromEmail = extractEmail(msg.from);
        const toEmail = extractEmail(msg.to);
        const matchedLead = (fromEmail && emailToLead[fromEmail]) || (toEmail && emailToLead[toEmail]);
        if (!matchedLead) continue;

        const existing = await railwayActivities.list({ lead_id: matchedLead.id, source: 'gmail' }).then(r => r.items || []).catch(() => []);
        const alreadySynced = existing.some(a => a.metadata?.gmail_message_id === msg.id);
        if (alreadySynced) continue;

        await railwayActivities.create({
          lead_id: matchedLead.id,
          type: 'email',
          timestamp: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(),
          content: msg.subject || '(no subject)',
          author: msg.from || '',
          source: 'gmail',
          metadata: { email_subject: msg.subject || '(no subject)', gmail_message_id: msg.id },
        }).catch(() => {});
        matched++;
      }

      setSyncResult({ success: true, synced: messages.length, matched });
    } catch (e) {
      setSyncResult({ success: false, error: e?.message || 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SyncSection>
      <SyncSectionHeader
        icon={Mail}
        title="Gmail / Email Sync"
        iconColor="text-blue-500"
        badge={{ label: "Railway Gmail API", className: "bg-blue-100 text-blue-700" }}
      />
      <p className="text-xs text-slate-500 mb-3">
        Gmail is read server-side via Railway. No Gmail token reaches the browser.
      </p>

      {status === null ? (
        <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking Gmail connection…
        </div>
      ) : status.connected ? (
        <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-emerald-900">Gmail Connected</p>
            <p className="text-[11px] text-emerald-700 mt-0.5">{status.email}</p>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
            style={{ minHeight: 'unset', minWidth: 'unset' }}
          >
            <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-slate-800">Gmail Not Available</p>
            <p className="text-[11px] text-slate-600 mt-1">
              Gmail is read through the Railway service. Ensure your Railway session is active and Gmail is connected there.
            </p>
            {status.reason && (
              <p className="text-[11px] text-amber-700 mt-1">{status.reason}</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            <a
              href="/integrations"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors whitespace-nowrap"
              style={{ minHeight: 'unset', minWidth: 'unset' }}
            >
              Connect Gmail
            </a>
            <button
              onClick={checkConnection}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
              style={{ minHeight: 'unset', minWidth: 'unset' }}
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        </div>
      )}

      {syncResult && (
        <div className={`mt-3 rounded-lg border p-3 text-xs ${
          syncResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          {syncResult.success
            ? `✓ Checked ${syncResult.synced} emails — ${syncResult.matched} new matched to leads`
            : `✗ ${syncResult.error}`}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-600 space-y-1">
        <p className="font-semibold text-slate-700 mb-2">How it works:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Gmail inbox is read server-side via Railway (no browser Gmail token)</li>
          <li>Emails matched to leads by sender/recipient email address</li>
          <li>Matched email activity appears in the lead's activity timeline</li>
        </ul>
      </div>
    </SyncSection>
  );
}