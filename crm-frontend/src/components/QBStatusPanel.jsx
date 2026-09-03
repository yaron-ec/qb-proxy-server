/**
 * QBStatusPanel — Native Railway QuickBooks status panel for Lead Detail.
 *
 * Reads from:
 *   - Railway leads table (qb_customer_id, qb_invoice_* fields)
 *   - Railway invoices table (CRM invoices)
 *   - Railway qb_invoices_cache + qb_invoice_sale_map (cached QB financials)
 *   - Railway handoff_estimates (QB estimates)
 *
 * Actions:
 *   - Sync to QB: creates/updates QB customer via existing QB proxy
 *   - Refresh from QB: pulls live QB customer + invoice data
 *
 * No Base44 calls. All data is native Railway/Postgres or via the existing
 * QB proxy (qbInternal.js).
 */
import { useState, useEffect, useCallback } from "react";
import { leadQB as railwayLeadQB } from "@/api/railway";
import { fmtMoney } from "@/lib/formatters";
import { useToast } from "@/components/ui/use-toast";
import { DollarSign, RefreshCw, ArrowRightLeft, FileText, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";

export default function QBStatusPanel({ lead, onLeadUpdated }) {
  const [qbData, setQbData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const { toast } = useToast();

  const loadStatus = useCallback(async () => {
    if (!lead?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await railwayLeadQB.getStatus(lead.id);
      setQbData(data);
    } catch (e) {
      // 404 "not_found" means the lead doesn't exist in Railway — show a
      // clean "Not connected" state, not a scary error.
      if (e.status === 404 || e.message === 'not_found') {
        setQbData({ qbConnected: false, crmInvoices: [], qbInvoices: [], estimates: [] });
      } else {
        setError(e.message || 'Failed to load QB status');
      }
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await railwayLeadQB.syncToQB(lead.id);
      toast({ title: 'Synced to QuickBooks', description: result.customer_id ? `Customer ID: ${result.customer_id}` : 'Customer updated', duration: 3000 });
      await loadStatus();
      if (onLeadUpdated) onLeadUpdated();
    } catch (e) {
      toast({ title: 'QB Sync Failed', description: e.message, variant: 'destructive', duration: 5000 });
    } finally {
      setSyncing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await railwayLeadQB.refreshFromQB(lead.id);
      toast({ title: 'Refreshed from QB', description: result.message, duration: 3000 });
      await loadStatus();
    } catch (e) {
      const isReconnect = e.message?.includes('RECONNECT');
      toast({ title: isReconnect ? 'QB Reconnect Required' : 'Refresh Failed', description: e.message, variant: 'destructive', duration: 5000 });
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center">
        <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-red-700">Failed to load QB status</p>
            <p className="text-[11px] text-red-500 mt-0.5">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const { qbConnected, qbReconnectRequired, crmInvoices = [], qbInvoices = [], estimates = [] } = qbData || {};
  const hasQbCustomer = !!lead.qb_customer_id || !!qbData?.lead?.qb_customer_id;

  return (
    <div className="space-y-3">
      {/* Connection status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${qbConnected ? 'bg-emerald-500' : 'bg-red-400'}`} />
          <span className="text-xs font-semibold text-slate-700">
            {qbConnected ? 'QuickBooks Connected' : 'QuickBooks Not Connected'}
          </span>
        </div>
        {qbReconnectRequired && (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-semibold">
            Reconnect Required
          </span>
        )}
      </div>

      {/* Customer match */}
      <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          {hasQbCustomer ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          ) : (
            <AlertCircle className="w-4 h-4 text-slate-400" />
          )}
          <div>
            <p className="text-xs font-semibold text-slate-700">QB Customer</p>
            <p className="text-[11px] text-slate-500">
              {hasQbCustomer ? `ID: ${lead.qb_customer_id || qbData?.lead?.qb_customer_id}` : 'Not matched'}
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSync}
          disabled={syncing || !qbConnected}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg transition-colors"
        >
          <ArrowRightLeft className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync to QB'}
        </button>
        <button
          onClick={handleRefresh}
          disabled={refreshing || !qbConnected}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* CRM Invoices */}
      {crmInvoices.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">CRM Invoices ({crmInvoices.length})</p>
          <div className="space-y-1.5">
            {crmInvoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">
                    {inv.qb_invoice_number || inv.invoice_number || 'Invoice'}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {inv.payment_stage || inv.status || '—'}
                    {inv.deal_id ? ` · Sale: ${inv.deal_id.substring(0, 8)}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-bold text-slate-800">{fmtMoney(inv.amount)}</p>
                  <p className={`text-[10px] font-semibold ${inv.synced_to_qb ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {inv.synced_to_qb ? '✓ Synced' : 'Not synced'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QB Cached Invoices */}
      {qbInvoices.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">QB Invoices ({qbInvoices.length})</p>
          <div className="space-y-1.5">
            {qbInvoices.map((inv, i) => (
              <div key={i} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">
                    #{inv.qb_doc_number || inv.qb_invoice_id}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {inv.voided ? 'Voided' : inv.txn_status || '—'}
                    {inv.crm_sale_id ? ` · Sale: ${inv.crm_sale_id.substring(0, 8)}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-bold text-slate-800">{fmtMoney(inv.total_amt)}</p>
                  <p className="text-[10px] text-slate-500">Bal: {fmtMoney(inv.balance)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Estimates */}
      {estimates.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Estimates ({estimates.length})</p>
          <div className="space-y-1.5">
            {estimates.map((est) => (
              <div key={est.id} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">
                    #{est.qb_estimate_number || est.qb_estimate_id}
                  </p>
                  <p className="text-[10px] text-slate-500">{est.estimate_status || '—'}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs font-bold text-slate-800">{fmtMoney(est.estimate_amount)}</span>
                  {est.qb_app_url && (
                    <a href={est.qb_app_url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-amber-600">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && crmInvoices.length === 0 && qbInvoices.length === 0 && estimates.length === 0 && (
        <div className="text-center py-4">
          <DollarSign className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
          <p className="text-xs text-slate-400">No QB data for this lead yet</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Use "Sync to QB" to create a customer</p>
        </div>
      )}
    </div>
  );
}