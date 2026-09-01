import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { deals as railwayDeals } from "@/api/railway";
import { Plus, Pencil, Trash2, X, Save, Star, ExternalLink } from "lucide-react";
import { statusBadgeClass } from "@/lib/design-system";
import RightPanelEmptyState from "@/components/RightPanelEmptyState";

const STAGES = [
  "Appointment Scheduled",
  "Qualified to Buy",
  "Presentation Scheduled",
  "Decision Maker Bought In",
  "Contract Sent",
  "Closed Won",
  "Closed Lost",
];

const STAGE_COLORS = {
  "Appointment Scheduled":    "bg-blue-100 text-blue-700",
  "Qualified to Buy":         "bg-emerald-100 text-emerald-700",
  "Presentation Scheduled":   "bg-purple-100 text-purple-700",
  "Decision Maker Bought In": "bg-indigo-100 text-indigo-700",
  "Contract Sent":            "bg-amber-100 text-amber-700",
  "Closed Won":               "bg-green-100 text-green-800",
  "Closed Lost":              "bg-red-100 text-red-700",
};

const EMPTY_FORM = { 
  name: "", 
  amount: "", 
  stage: "Appointment Scheduled", 
  close_date: "",
  sale_amount: "",
  deposit_amount: "",
  deposit_paid: "",
  progress_payment_amount: "",
  progress_payment_paid: "",
  final_payment_amount: "",
  final_payment_paid: ""
};

const fmtMoney = (v) => v ? `$${Number(v).toLocaleString("en-US")}` : null;

export default function DealsPanel({ lead, onLeadUpdate }) {
  const navigate = useNavigate();
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadDeals();
  }, [lead.id]);

  const loadDeals = async () => {
    const res = await railwayDeals.list({ leadId: lead.railway_id });
    const data = res.items || [];
    setDeals(data.sort((a, b) => new Date(b.created_date || b.created_at) - new Date(a.created_date || a.created_at)));
    setLoading(false);
  };

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const res = await railwayDeals.create({
      lead_id: lead.railway_id,
      name: form.name,
      amount: form.amount ? parseFloat(form.amount) : null,
      stage: form.stage,
      close_date: form.close_date || null,
      sale_amount: form.sale_amount ? parseFloat(form.sale_amount) : 0,
      deposit_amount: form.deposit_amount ? parseFloat(form.deposit_amount) : 0,
      deposit_paid: form.deposit_paid ? parseFloat(form.deposit_paid) : 0,
      progress_payment_amount: form.progress_payment_amount ? parseFloat(form.progress_payment_amount) : 0,
      progress_payment_paid: form.progress_payment_paid ? parseFloat(form.progress_payment_paid) : 0,
      final_payment_amount: form.final_payment_amount ? parseFloat(form.final_payment_amount) : 0,
      final_payment_paid: form.final_payment_paid ? parseFloat(form.final_payment_paid) : 0,
    });
    const created = res?.deal || res;
    setSaving(false);
    setShowForm(false);
    navigate(`/deals/${created.id}`);
  };

  const handleDelete = async (dealId) => {
    if (!confirm("Delete this deal?")) return;
    await railwayDeals.remove(dealId);
    loadDeals();
  };

  return (
    <div>
      {/* Slim action bar */}
      <div className="flex items-center justify-end px-4 py-2 border-b border-slate-100 bg-slate-50/50">
        <button onClick={openAdd} className="flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900 transition-colors btn-compact">
          <Plus className="w-3 h-3" /> Add Deal
        </button>
      </div>
    <div>
      {/* New Deal Form */}
      {showForm && (
        <div className="mx-3 mb-3 border border-blue-200 rounded bg-blue-50 p-3 space-y-2">
          <div className="text-xs font-bold text-blue-800 mb-1">New Deal</div>
          <input
            type="text"
            placeholder="Deal name *"
            autoFocus
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400 bg-white"
          />
          <input
            type="number"
            placeholder="Amount ($)"
            value={form.amount}
            onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
            className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400 bg-white"
          />
          <input
            type="number"
            placeholder="Sale Amount ($)"
            value={form.sale_amount}
            onChange={e => setForm(p => ({ ...p, sale_amount: e.target.value }))}
            className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400 bg-white"
          />
          <select
            value={form.stage}
            onChange={e => setForm(p => ({ ...p, stage: e.target.value }))}
            className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400 bg-white"
          >
            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <div>
            <label className="block text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1">Close Date</label>
            <input
              type="date"
              value={form.close_date}
              onChange={e => setForm(p => ({ ...p, close_date: e.target.value }))}
              className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400 bg-white"
            />
          </div>
          <div className="border-t border-blue-200 pt-2 mt-2">
            <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-2">Payment Stages</div>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input type="number" placeholder="Deposit Amount" value={form.deposit_amount} onChange={e => setForm(p => ({ ...p, deposit_amount: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
                <input type="number" placeholder="Deposit Paid" value={form.deposit_paid} onChange={e => setForm(p => ({ ...p, deposit_paid: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" placeholder="Progress Amount" value={form.progress_payment_amount} onChange={e => setForm(p => ({ ...p, progress_payment_amount: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
                <input type="number" placeholder="Progress Paid" value={form.progress_payment_paid} onChange={e => setForm(p => ({ ...p, progress_payment_paid: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" placeholder="Final Amount" value={form.final_payment_amount} onChange={e => setForm(p => ({ ...p, final_payment_amount: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
                <input type="number" placeholder="Final Paid" value={form.final_payment_paid} onChange={e => setForm(p => ({ ...p, final_payment_paid: e.target.value }))} className="border border-slate-200 rounded px-2 py-1 text-xs bg-white" />
              </div>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 bg-orange text-white px-2.5 py-1.5 text-[10px] font-bold rounded hover:bg-orange/90 disabled:opacity-50"
            >
              <Save className="w-3 h-3" />
              {saving ? "Saving..." : "Save & Open"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="flex items-center gap-1 border border-slate-300 text-slate-700 bg-white px-2.5 py-1.5 text-[10px] font-bold rounded hover:bg-slate-50"
            >
              <X className="w-3 h-3" />Cancel
            </button>
          </div>
        </div>
      )}

      {/* Total Sales */}
       {!loading && deals.length > 0 && (
         <div className="mx-3 mb-3 bg-emerald-50 rounded-lg p-3 border border-emerald-200">
           <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-600 mb-1">Total Sales</p>
           <p className="text-base font-bold text-emerald-900">{fmtMoney(deals.reduce((sum, d) => sum + (d.sale_amount || 0), 0))}</p>
         </div>
       )}

      {/* Deals list */}
       {!loading && deals.length === 0 && !showForm ? (
         <RightPanelEmptyState
           icon={Star}
           title="No deals yet"
           description="Click Add to create one"
         />
       ) : (
         <div className="space-y-2">
          {deals.map((deal) => (
            <div
              key={deal.id}
              className="border border-slate-200 rounded p-2.5 bg-white hover:bg-slate-50 group relative cursor-pointer"
              onClick={() => navigate(`/deals/${deal.id}`)}
            >
              <div className="flex items-start justify-between gap-1">
                <div className="text-xs font-semibold text-slate-800 leading-tight flex-1 min-w-0 truncate">{deal.name}</div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" onClick={e => e.stopPropagation()}>
                  <button onClick={() => navigate(`/deals/${deal.id}`)} className="text-slate-400 hover:text-blue-600 transition-colors" title="Open deal">
                    <ExternalLink className="w-3 h-3" />
                  </button>
                  <button onClick={() => handleDelete(deal.id)} className="text-slate-400 hover:text-red-500 transition-colors" title="Delete">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {deal.amount && (
                <div className="text-sm text-slate-800 font-bold mt-1">{fmtMoney(deal.amount)}</div>
              )}
              {deal.sale_amount && (
                <div className="text-sm text-emerald-700 font-bold mt-1">Sale: {fmtMoney(deal.sale_amount)}</div>
              )}
              {deal.stage && (
                <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap mt-1 ${STAGE_COLORS[deal.stage] || "bg-slate-100 text-slate-600"}`}>
                  {deal.stage}
                </span>
              )}
              {deal.close_date && (
                <div className="text-[10px] text-slate-400 mt-1">Close: {deal.close_date}</div>
              )}
              {(deal.deposit_paid || deal.progress_payment_paid || deal.final_payment_paid) && (
                <div className="text-[10px] text-slate-600 mt-2 space-y-0.5">
                  {deal.deposit_paid > 0 && <div>💰 Deposit: {fmtMoney(deal.deposit_paid)}</div>}
                  {deal.progress_payment_paid > 0 && <div>📊 Progress: {fmtMoney(deal.progress_payment_paid)}</div>}
                  {deal.final_payment_paid > 0 && <div>✅ Final: {fmtMoney(deal.final_payment_paid)}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}