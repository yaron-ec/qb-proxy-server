import { useState, useEffect, useCallback } from "react";
import { qb as railwayQb } from "@/api/railway";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, RefreshCw, Save, Receipt } from "lucide-react";
import { SyncSection, SyncSectionHeader, SyncInfoNotice } from "./SyncCard";

/**
 * QbInvoiceConfigPanel — the one admin-set default QuickBooks Item used by
 * real Estimate/Invoice creation from a Deal (CRM STABILITY PHASE,
 * completion pass, Section B). lib/qbEstimateInvoice.js never invents an
 * ItemRef — GET /api/v1/qb/items is a live, READ-ONLY query of this
 * account's real Items, so the admin picks their own, real item instead of
 * one being guessed.
 */
export default function QbInvoiceConfigPanel() {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedItemRef, setSelectedItemRef] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [itemsRes, configRes] = await Promise.all([
        railwayQb.listItems().catch((e) => ({ error: e.message })),
        railwayQb.getInvoiceConfig().catch(() => ({ config: null })),
      ]);
      if (itemsRes?.items) setItems(itemsRes.items);
      else setLoadError(itemsRes?.error || "Failed to load QuickBooks items");
      if (configRes?.config?.item_ref) setSelectedItemRef(configRes.config.item_ref);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const item = items.find((i) => i.id === selectedItemRef);
    if (!item) {
      toast({ title: "Select an Item first", variant: "destructive", duration: 3000 });
      return;
    }
    setSaving(true);
    try {
      await railwayQb.setInvoiceConfig({
        item_ref: item.id, item_name: item.name,
        income_account_ref: item.income_account_ref, income_account_name: item.income_account_name,
      });
      toast({ title: "QuickBooks invoice item saved", description: `"${item.name}" will be used on every Estimate/Invoice created from a Deal.`, duration: 4000 });
    } catch (e) {
      toast({ title: "Failed to save", description: e.message, variant: "destructive", duration: 5000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SyncSection>
      <SyncSectionHeader
        icon={Receipt}
        title="Invoice/Estimate Line Item"
        iconColor="text-amber-500"
        action={
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        }
      />
      <SyncInfoNotice variant="blue">
        <p>
          Real Estimates/Invoices created from a Deal (the "Create QB Estimate"/"Create QB Invoice" buttons on a
          Deal's Financials tab) need ONE default QuickBooks Item for their line item. Pick your real item below —
          it is never guessed.
        </p>
      </SyncInfoNotice>
      {loadError ? (
        <p className="text-xs text-red-600 mt-2">{loadError}</p>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          <select
            value={selectedItemRef}
            onChange={(e) => setSelectedItemRef(e.target.value)}
            className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
          >
            <option value="">— Select a QuickBooks Item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.type})</option>
            ))}
          </select>
          <button
            onClick={save}
            disabled={saving || !selectedItemRef}
            className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
        </div>
      )}
    </SyncSection>
  );
}
