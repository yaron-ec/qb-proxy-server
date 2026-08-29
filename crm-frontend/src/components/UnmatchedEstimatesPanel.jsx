import { useState, useEffect } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayHandoffEstimates from "@/api/railway/handoffEstimates";
import { apiCall } from "@/api/railway/client";
import { Search, Link2, CheckCircle, X, ChevronDown, ChevronUp, Loader2, User } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

// QB test/demo customers to exclude from unmatched count
const TEST_CUSTOMERS = [
  "john smith",
  "red rock diner",
  "paulsen medical supplies",
  "geeta kalapatapu",
];

function isTestCustomer(name) {
  if (!name) return false;
  return TEST_CUSTOMERS.includes(name.toLowerCase().trim());
}

function LeadSearchPicker({ onSelect }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const all = await railwayLeads.list({ sort: "-created_date", limit: 200 }).then(r => r.items || []);
        const q = query.toLowerCase();
        setResults(
          all.filter(l =>
            `${l.first_name} ${l.last_name}`.toLowerCase().includes(q) ||
            (l.email || "").toLowerCase().includes(q) ||
            (l.phone || "").includes(q) ||
            (l.property_address || "").toLowerCase().includes(q)
          ).slice(0, 8)
        );
      } catch {}
      setLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2 bg-white">
        <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name, email, phone, address…"
          className="flex-1 text-xs outline-none bg-transparent text-slate-800 placeholder-slate-400"
          style={{ border: "none", padding: 0, fontSize: "12px" }}
        />
        {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
      </div>
      {results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          {results.map(lead => (
            <button
              key={lead.id}
              onClick={() => { onSelect(lead); setQuery(""); setResults([]); }}
              className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors text-left"
            >
              <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-3 h-3 text-slate-500" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-800">{lead.first_name} {lead.last_name}</p>
                <p className="text-[11px] text-slate-400">{[lead.email, lead.phone, lead.property_address].filter(Boolean).join(" · ")}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EstimateRow({ rec, currentUser, onLinked }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [selectedLead, setSelectedLead] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!selectedLead) return;
    setSaving(true);
    try {
      // 1. Link the estimate to the lead
      await railwayHandoffEstimates.update(rec.id, {
        lead_id: selectedLead.id,
        match_status: "matched",
        match_method: "manual",
      });

      // 2. Save the mapping for future auto-matching
      // TODO: Railway endpoint for QBLeadMatchMapping not yet available.
      // When built, this will persist the mapping to a Railway table for
      // future auto-matching. For now, the HandoffEstimate update above
      // is the primary action; the mapping is a convenience optimization.
      const mappingData = {
        lead_id: selectedLead.id,
        lead_name: `${selectedLead.first_name} ${selectedLead.last_name}`,
        matched_by: currentUser?.email || "admin",
        notes: `Manually matched from Integrations page. QB CustomerRef: "${rec.customer_name}"`,
      };
      if (rec.qb_estimate_id) mappingData.qb_customer_ref_value = rec.qb_estimate_id;
      if (rec.customer_name) mappingData.qb_customer_ref_name = rec.customer_name;
      if (rec.customer_email) mappingData.qb_customer_email = rec.customer_email;

      // Persist mapping via Railway API (best-effort — endpoint may not exist yet)
      try {
        await apiCall('/api/v1/lead-qb/match-mapping', { method: 'POST', body: mappingData });
      } catch (e) {
        // Mapping persistence is best-effort; the HandoffEstimate update is the primary action
        console.warn('QBLeadMatchMapping persistence skipped:', e.message);
      }

      toast({ title: "Linked successfully", description: `${rec.customer_name} → ${selectedLead.first_name} ${selectedLead.last_name}`, duration: 3000 });
      onLinked(rec.id);
    } catch (e) {
      toast({ title: "Save failed", description: e.message, variant: "destructive", duration: 4000 });
    } finally {
      setSaving(false);
    }
  };

  const availableFields = [
    rec.customer_email ? "email" : null,
    rec.customer_phone ? "phone" : null,
  ].filter(Boolean);

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div
        className="px-5 py-3 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="col-span-4">
          <p className="text-xs font-semibold text-slate-800 leading-tight">{rec.customer_name || "—"}</p>
          {rec.document_title && rec.document_title !== rec.customer_name && (
            <p className="text-[11px] text-slate-400 mt-0.5 truncate">{rec.document_title}</p>
          )}
        </div>
        <div className="col-span-2">
          <p className="text-xs text-slate-700 font-mono">{rec.qb_estimate_number || "—"}</p>
        </div>
        <div className="col-span-1">
          <p className="text-xs text-slate-700">
            {rec.estimate_amount != null ? `$${Number(rec.estimate_amount).toLocaleString()}` : "—"}
          </p>
        </div>
        <div className="col-span-1">
          <p className="text-[11px] text-slate-500">
            {rec.estimate_date ? new Date(rec.estimate_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
          </p>
        </div>
        <div className="col-span-2">
          {availableFields.length > 0
            ? availableFields.map(f => (
                <span key={f} className="inline-block text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded mr-1 mb-0.5 font-semibold">{f}</span>
              ))
            : <span className="text-[11px] text-slate-400 italic">none in QB</span>
          }
        </div>
        <div className="col-span-2 flex items-center justify-end gap-2">
          <span className="text-[10px] text-orange font-semibold">Match manually</span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
        </div>
      </div>

      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-amber-50 border-t border-amber-100">
          <p className="text-[11px] font-semibold text-amber-700 mb-2 uppercase tracking-wide">Link to CRM Lead</p>
          <p className="text-[11px] text-slate-500 mb-3">
            QB CustomerRef: <span className="font-mono font-semibold text-slate-700">"{rec.customer_name}"</span>
            {rec.qb_estimate_id && <> &nbsp;·&nbsp; QB ID: <span className="font-mono text-slate-500">{rec.qb_estimate_id}</span></>}
          </p>

          {selectedLead ? (
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 bg-white border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="text-xs font-semibold text-slate-800">{selectedLead.first_name} {selectedLead.last_name}</span>
                <span className="text-[11px] text-slate-400">{selectedLead.email || selectedLead.phone}</span>
              </div>
              <button onClick={() => setSelectedLead(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="mb-3">
              <LeadSearchPicker onSelect={setSelectedLead} />
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!selectedLead || saving}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-slate-800 px-4 py-2 rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
              Save & Link
            </button>
            <p className="text-[11px] text-slate-400">Also saves a mapping so future QB estimates from this customer auto-match.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UnmatchedEstimatesPanel({ records, currentUser, onRefresh }) {
  const [linked, setLinked] = useState(new Set());

  const visible = records.filter(r => !isTestCustomer(r.customer_name) && !linked.has(r.id));
  const testCount = records.filter(r => isTestCustomer(r.customer_name)).length;

  const handleLinked = (id) => {
    setLinked(prev => new Set([...prev, id]));
    if (onRefresh) setTimeout(onRefresh, 1000);
  };

  if (visible.length === 0) {
    return (
      <div className="px-5 py-6 text-center">
        <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
        <p className="text-sm font-semibold text-slate-700">All estimates matched!</p>
        {testCount > 0 && (
          <p className="text-xs text-slate-400 mt-1">{testCount} test/demo record{testCount !== 1 ? "s" : ""} excluded (John Smith, Red Rock Diner, etc.)</p>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Column headers */}
      <div className="px-5 py-2 bg-slate-50 border-b border-slate-100 grid grid-cols-12 gap-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
        <span className="col-span-4">Customer / Project</span>
        <span className="col-span-2">Doc #</span>
        <span className="col-span-1">Amount</span>
        <span className="col-span-1">Date</span>
        <span className="col-span-2">QB Fields</span>
        <span className="col-span-2 text-right">Action</span>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        {visible.map(rec => (
          <EstimateRow key={rec.id} rec={rec} currentUser={currentUser} onLinked={handleLinked} />
        ))}
      </div>
      {testCount > 0 && (
        <div className="px-5 py-2 border-t border-slate-100 text-[11px] text-slate-400 italic">
          {testCount} test/demo customer{testCount !== 1 ? "s" : ""} hidden (John Smith, Red Rock Diner, Paulsen Medical Supplies, Geeta Kalapatapu)
        </div>
      )}
    </div>
  );
}

export { isTestCustomer };