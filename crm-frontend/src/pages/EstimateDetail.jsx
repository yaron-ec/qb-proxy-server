import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { apiCall } from "@/api/railway/client";
import { ArrowLeft, Save, Trash2, Plus, X } from "lucide-react";

const STATUSES = ["Draft", "Sent", "Viewed", "Accepted", "Declined"];

const EMPTY_LINE = { description: "", quantity: 1, unit: "LS", unit_cost: 0, total: 0, category: "" };

export default function EstimateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "", status: "Draft", lead_id: "", project_id: "",
    line_items: [{ ...EMPTY_LINE }],
    subtotal: 0, markup_pct: 20, total: 0, deposit_amount: 0,
    notes: "", valid_until: "",
  });

  useEffect(() => {
    if (!isNew) {
      apiCall(`/api/v1/estimates/${id}`, { method: 'GET' }).then(data => {
        setForm({ ...data, line_items: data.line_items?.length ? data.line_items : [{ ...EMPTY_LINE }] });
        setLoading(false);
      });
    }
  }, [id]);

  const recalc = (items, markupPct) => {
    const sub = items.reduce((s, i) => s + (i.total || 0), 0);
    const total = sub * (1 + (markupPct || 0) / 100);
    return { subtotal: sub, total: parseFloat(total.toFixed(2)) };
  };

  const updateLine = (idx, field, val) => {
    const items = form.line_items.map((item, i) => {
      if (i !== idx) return item;
      const updated = { ...item, [field]: val };
      if (field === "quantity" || field === "unit_cost") {
        updated.total = parseFloat((updated.quantity || 0) * (updated.unit_cost || 0)).toFixed(2);
        updated.total = parseFloat(updated.total);
      }
      return updated;
    });
    const { subtotal, total } = recalc(items, form.markup_pct);
    setForm(p => ({ ...p, line_items: items, subtotal, total }));
  };

  const addLine = () => {
    setForm(p => ({ ...p, line_items: [...p.line_items, { ...EMPTY_LINE }] }));
  };

  const removeLine = (idx) => {
    const items = form.line_items.filter((_, i) => i !== idx);
    const { subtotal, total } = recalc(items, form.markup_pct);
    setForm(p => ({ ...p, line_items: items, subtotal, total }));
  };

  const updateMarkup = (val) => {
    const m = parseFloat(val) || 0;
    const { subtotal, total } = recalc(form.line_items, m);
    setForm(p => ({ ...p, markup_pct: m, subtotal, total }));
  };

  const save = async () => {
    setSaving(true);
    if (isNew) {
      const created = await apiCall('/api/v1/estimates', { method: 'POST', body: form });
      navigate(`/estimates/${created.id}`);
    } else {
      await apiCall(`/api/v1/estimates/${id}`, { method: 'PUT', body: form });
    }
    setSaving(false);
  };

  const remove = async () => {
    if (confirm("Delete this estimate?")) {
      await apiCall(`/api/v1/estimates/${id}`, { method: 'DELETE' });
      navigate("/estimates");
    }
  };

  const marginPct = form.total > 0 ? ((form.total - form.subtotal) / form.total * 100).toFixed(1) : 0;
  const marginColor = marginPct > 25 ? "bg-emerald-600" : marginPct > 15 ? "bg-orange" : "bg-destructive";

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-muted border-t-orange rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-8 border-b border-border pb-6">
        <Link to="/estimates" className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground hover:text-orange mb-4 transition-colors">
          <ArrowLeft className="w-3 h-3" /> Back to Estimates
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-black text-midnight uppercase tracking-tight">
              {isNew ? "New Estimate" : (form.title || "Estimate")}
            </h1>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-orange text-white px-4 py-2.5 text-xs font-bold tracking-widest uppercase hover:bg-orange/90 transition-colors disabled:opacity-50">
              <Save className="w-3 h-3" /> {saving ? "Saving..." : "Save"}
            </button>
            {!isNew && (
              <button onClick={remove}
                className="flex items-center gap-2 bg-white border border-destructive text-destructive px-4 py-2.5 text-xs font-bold uppercase tracking-widest hover:bg-destructive hover:text-white transition-colors">
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Margin Bar */}
      <div className="bg-white border border-border p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">Projected Margin</span>
          <span className="text-sm font-black text-midnight">{marginPct}%</span>
        </div>
        <div className="w-full bg-muted h-2">
          <div className={`h-2 transition-all duration-500 ${marginColor}`} style={{ width: `${Math.min(marginPct, 100)}%` }} />
        </div>
        <div className="flex justify-between mt-2 text-[10px] font-mono text-muted-foreground">
          <span>Subtotal: ${(form.subtotal || 0).toLocaleString()}</span>
          <span className="font-black text-midnight text-sm">Total: ${(form.total || 0).toLocaleString()}</span>
        </div>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Line Items */}
        <div className="lg:col-span-3 space-y-6">
          <section className="bg-white border border-border p-6">
            <h2 className="text-xs font-black tracking-widest uppercase text-midnight mb-5 pb-3 border-b border-border">Estimate Info</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="col-span-2">
                <EField label="Estimate Title *" value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} />
              </div>
              <EField label="Valid Until" value={form.valid_until} onChange={v => setForm(p => ({ ...p, valid_until: v }))} type="date" />
              <EField label="Deposit Amount ($)" value={form.deposit_amount} onChange={v => setForm(p => ({ ...p, deposit_amount: parseFloat(v) || 0 }))} type="number" />
            </div>
          </section>

          <section className="bg-white border border-border p-6">
            <div className="flex items-center justify-between mb-5 pb-3 border-b border-border">
              <h2 className="text-xs font-black tracking-widest uppercase text-midnight">Line Items</h2>
              <button onClick={addLine}
                className="flex items-center gap-2 bg-midnight text-white px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase hover:bg-midnight/80 transition-colors">
                <Plus className="w-3 h-3" /> Add Line
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="bg-concrete border-b border-border">
                    {["Description", "Category", "Qty", "Unit", "Unit Cost", "Total", ""].map(h => (
                      <th key={h} className="text-left px-2 py-2 text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {form.line_items.map((item, idx) => (
                    <tr key={idx} className="border-b border-border last:border-0">
                      <td className="px-2 py-2">
                        <input className="w-40 border border-border bg-concrete px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange"
                          value={item.description} onChange={e => updateLine(idx, "description", e.target.value)} />
                      </td>
                      <td className="px-2 py-2">
                        <input className="w-24 border border-border bg-concrete px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange"
                          value={item.category} onChange={e => updateLine(idx, "category", e.target.value)} placeholder="Labor/Mat" />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" className="w-16 border border-border bg-concrete px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange"
                          value={item.quantity} onChange={e => updateLine(idx, "quantity", parseFloat(e.target.value) || 0)} />
                      </td>
                      <td className="px-2 py-2">
                        <input className="w-14 border border-border bg-concrete px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange"
                          value={item.unit} onChange={e => updateLine(idx, "unit", e.target.value)} />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" className="w-24 border border-border bg-concrete px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange"
                          value={item.unit_cost} onChange={e => updateLine(idx, "unit_cost", parseFloat(e.target.value) || 0)} />
                      </td>
                      <td className="px-2 py-2 text-xs font-black font-mono text-midnight">
                        ${(item.total || 0).toLocaleString()}
                      </td>
                      <td className="px-2 py-2">
                        {form.line_items.length > 1 && (
                          <button onClick={() => removeLine(idx)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Notes */}
          <section className="bg-white border border-border p-6">
            <h2 className="text-xs font-black tracking-widest uppercase text-midnight mb-4 pb-3 border-b border-border">Notes</h2>
            <textarea rows={3} className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors resize-none"
              value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <section className="bg-white border border-border p-5">
            <h2 className="text-[10px] font-black tracking-widest uppercase text-midnight mb-4 pb-2 border-b border-border">Status</h2>
            <ESelect label="Estimate Status" value={form.status} onChange={v => setForm(p => ({ ...p, status: v }))} options={STATUSES} />
          </section>

          <section className="bg-white border border-border p-5">
            <h2 className="text-[10px] font-black tracking-widest uppercase text-midnight mb-4 pb-2 border-b border-border">Pricing</h2>
            <div className="space-y-3">
              <EField label="Markup %" value={form.markup_pct} onChange={updateMarkup} type="number" />
              <div className="pt-3 border-t border-border space-y-1">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-muted-foreground uppercase tracking-wider">Subtotal</span>
                  <span className="font-bold">${(form.subtotal || 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm font-mono">
                  <span className="font-black uppercase tracking-wider text-midnight">Total</span>
                  <span className="font-black text-orange">${(form.total || 0).toLocaleString()}</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EField({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground mb-1">{label}</label>
      <input type={type} className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function ESelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground mb-1">{label}</label>
      <select className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors"
        value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}