import { useState, useEffect, useMemo } from "react";
import * as railwayLeads from "@/api/railway/leads";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Plus, Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download } from "lucide-react";

// Tabs are dynamically built from unique assigned_rep values + "All Leads"

const STATUS_COLOR = {
  "New": "text-blue-600",
  "Appointment scheduled": "text-green-600",
  "Answered, no appointment set": "text-orange-500",
  "No answer": "text-gray-500",
  "Proposal Sent": "text-amber-600",
  "No show": "text-red-400",
  "DNQ": "text-gray-400",
  "Sold": "text-green-700 font-semibold",
  "Lost": "text-red-600",
};

const PAGE_SIZE = 100;

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtApptDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("my_contacts");
  const [page, setPage] = useState(1);

  // Build dynamic tabs from unique reps
  const tabs = useMemo(() => {
    const reps = [...new Set(leads.map(l => l.assigned_rep).filter(Boolean))].sort();
    return [
      { id: "my_contacts", label: "My Contacts" },
      { id: "all", label: "All Leads" },
      { id: "sold", label: "Sold" },
      ...reps.map(rep => ({ id: rep, label: rep.split("@")[0] })),
    ];
  }, [leads]);

  const tabFilter = (lead) => {
    if (activeTab === "my_contacts") return lead.status !== "New" && lead.status !== "Sold";
    if (activeTab === "all") return true;
    if (activeTab === "sold") return lead.status === "Sold";
    return lead.assigned_rep === activeTab;
  };
  const [sortField, setSortField] = useState("follow_up_date");
  const [sortDir, setSortDir] = useState("desc");
  const [selected, setSelected] = useState(new Set());
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterBudget, setFilterBudget] = useState("");
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    railwayLeads.list({ sort: "-created_date", limit: 500 }).then(r => r.items || []).then(data => {
      setLeads(data);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    return leads.filter(l => {
      const tabOk = tabFilter(l);
      const name = `${l.first_name} ${l.last_name}`.toLowerCase();
      const searchOk = !search || name.includes(search.toLowerCase()) ||
        (l.email || "").toLowerCase().includes(search.toLowerCase()) ||
        (l.phone || "").includes(search) ||
        (l.city || "").toLowerCase().includes(search.toLowerCase());
      const statusOk = !filterStatus || l.status === filterStatus;
      const sourceOk = !filterSource || l.source === filterSource;
      const budgetOk = !filterBudget || l.budget_range === filterBudget;
      return tabOk && searchOk && statusOk && sourceOk && budgetOk;
    });
  }, [leads, activeTab, search, filterStatus, filterSource, filterBudget]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortField] || "";
      const bv = b[sortField] || "";
      return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const toggleAll = () => {
    if (selected.size === paginated.length) setSelected(new Set());
    else setSelected(new Set(paginated.map(l => l.id)));
  };

  const handleExport = async () => {
    const response = await apiCall('/api/v1/export-leads', { method: 'POST', body: {} });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `backup_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
  };

  const startEdit = (leadId, field, currentValue) => {
    setEditing({ id: leadId, field });
    setEditValue(currentValue || "");
  };

  const saveEdit = async (leadId, field) => {
    if (!editValue.trim() && field !== "follow_up_date") return;
    await railwayLeads.update(leadId, { [field]: editValue });
    const updated = await railwayLeads.list({ sort: "-created_date", limit: 500 }).then(r => r.items || []);
    setLeads(updated);
    setEditing(null);
    if (field === "status" && editValue === "Sold") {
      setActiveTab("sold");
    }
  };

  const handleStatusChange = async (leadId, newStatus) => {
    await railwayLeads.update(leadId, { status: newStatus });
    const updated = await railwayLeads.list({ sort: "-created_date", limit: 500 }).then(r => r.items || []);
    setLeads(updated);
    setEditing(null);
    if (newStatus === "Sold") {
      setActiveTab("sold");
    }
  };

  const tabCounts = useMemo(() => {
    const out = {
      my_contacts: leads.filter(l => l.status !== "New" && l.status !== "Sold").length,
      all: leads.length,
      sold: leads.filter(l => l.status === "Sold").length,
    };
    for (const tab of tabs.slice(3)) {
      out[tab.id] = leads.filter(l => l.assigned_rep === tab.id).length;
    }
    return out;
  }, [leads, tabs]);

  return (
    <div className="flex flex-col h-full bg-white text-[13px]">

      {/* Top tab bar */}
      <div className="border-b border-gray-200 bg-white px-4 flex items-center gap-1 flex-shrink-0">
        <div className="flex items-center gap-0 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setPage(1); }}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium border-b-2 whitespace-nowrap transition-colors
                ${activeTab === tab.id
                  ? "border-[#0091ae] text-[#0091ae]"
                  : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
                }`}
            >
              {tab.label}
              <span className={`text-[11px] px-1 py-0.5 rounded-full font-medium
                ${activeTab === tab.id ? "bg-[#0091ae]/10 text-[#0091ae]" : "bg-gray-100 text-gray-500"}`}>
                {tabCounts[tab.id]}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex-shrink-0 flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 border border-slate-300 hover:bg-slate-50 text-slate-700 px-3 py-1.5 text-[12px] font-semibold rounded transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <Link
            to="/capture"
            className="flex items-center gap-1.5 bg-orange hover:bg-orange/90 text-white px-3 py-1.5 text-[12px] font-semibold rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add contacts
          </Link>
        </div>
      </div>

      {/* Search + Filters bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
        <div className="relative w-52">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            className="w-full border border-gray-300 rounded pl-8 pr-3 py-1.5 text-[12px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#0091ae] focus:border-[#0091ae]"
            placeholder="Search name, email, phone..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-[12px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#0091ae] focus:border-[#0091ae] bg-white"
          value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
        >
          <option value="">All Statuses</option>
          {["New","Appointment scheduled","Answered, no appointment set","No answer","Proposal Sent","No show","DNQ","Sold","Lost"].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-[12px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#0091ae] focus:border-[#0091ae] bg-white"
          value={filterSource}
          onChange={e => { setFilterSource(e.target.value); setPage(1); }}
        >
          <option value="">All Sources</option>
          {["Google Search","Google Maps / reviews","Referral","Instagram / Facebook","YouTube","Repeat customer","Other"].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-[12px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#0091ae] focus:border-[#0091ae] bg-white"
          value={filterBudget}
          onChange={e => { setFilterBudget(e.target.value); setPage(1); }}
        >
          <option value="">All Budgets</option>
          {["Under $25,000","$25,000–$75,000","$75,000–$150,000","$150,000–$300,000","$300,000+"].map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        {(filterStatus || filterSource || filterBudget) && (
          <button
            onClick={() => { setFilterStatus(""); setFilterSource(""); setFilterBudget(""); setPage(1); }}
            className="text-[11px] text-red-500 hover:text-red-700 font-semibold px-1"
          >
            ✕ Clear filters
          </button>
        )}
        <span className="text-[11px] text-gray-500 ml-1">{filtered.length} results</span>
        {selected.size > 0 && (
          <span className="bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 text-[11px] rounded font-medium">
            {selected.size} selected
          </span>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0091ae] rounded-full animate-spin" />
          </div>
        ) : (
          <table className="w-full min-w-[1100px] border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-9 pl-4 py-2.5 text-left">
                  <input type="checkbox"
                    checked={selected.size === paginated.length && paginated.length > 0}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 rounded border-gray-300 accent-[#0091ae]" />
                </th>
                <ColHeader label="NAME" field="first_name" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="FOLLOW UP DATE" field="follow_up_date" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="FOLLOW UP TIME" field="follow_up_time" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="JOB TYPE" field="project_type" current={sortField} dir={sortDir} onClick={handleSort} />

                <ColHeader label="PHONE NUMBER" field="phone" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="EMAIL" field="email" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="CITY" field="city" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="LEAD STATUS" field="status" current={sortField} dir={sortDir} onClick={handleSort} />
                <ColHeader label="CONTACT OWNER" field="assigned_rep" current={sortField} dir={sortDir} onClick={handleSort} />
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-16 text-[12px] text-gray-400">
                    No contacts found
                  </td>
                </tr>
              ) : paginated.map((lead, i) => (
                <tr key={lead.id}
                  className={`border-b border-gray-100 hover:bg-[#f5f8fa] transition-colors cursor-pointer
                    ${selected.has(lead.id) ? "bg-blue-50" : ""}`}
                >
                  <td className="pl-4 py-2">
                    <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggleSelect(lead.id)}
                      className="w-3.5 h-3.5 rounded border-gray-300 accent-[#0091ae]" onClick={e => e.stopPropagation()} />
                  </td>
                  {/* Avatar + Name */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-gray-600">
                        {(lead.first_name?.[0] || "")}{(lead.last_name?.[0] || "")}
                      </div>
                      <Link to={`/leads/${lead.id}`} className="text-[#0091ae] hover:underline font-medium text-[12px]">
                        {lead.first_name} {lead.last_name}
                      </Link>
                    </div>
                  </td>
                  <td className={`px-3 py-2 text-[12px] cursor-pointer hover:bg-blue-50 ${editing?.id === lead.id && editing?.field === "follow_up_date" ? "bg-blue-50" : ""}`} onClick={() => startEdit(lead.id, "follow_up_date", lead.follow_up_date)}>
                    {editing?.id === lead.id && editing?.field === "follow_up_date" ? (
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <input type="date" className="border border-blue-300 rounded px-2 py-0.5 text-xs text-slate-900 font-semibold bg-white" value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus />
                        <button onClick={() => saveEdit(lead.id, "follow_up_date")} className="bg-orange text-white px-2 rounded text-[10px] font-bold">✓</button>
                        <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-red-500 text-[10px]">✕</button>
                      </div>
                    ) : (
                      <span className="text-gray-700">{fmtDate(lead.follow_up_date)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-gray-700">{lead.follow_up_time || "—"}</td>
                  <td className="px-3 py-2 text-[12px] text-gray-700 cursor-pointer hover:bg-blue-50" onClick={() => startEdit(lead.id, "project_type", lead.project_type)}>
                    {editing?.id === lead.id && editing?.field === "project_type" ? (
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <select className="border border-blue-300 rounded px-2 py-0.5 text-xs text-slate-900 font-semibold bg-white" value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus>
                          <option value="">— Select —</option>
                          {["Kitchen remodel","Bathroom remodel","ADU / garage conversion","Addition","Full-home remodel","Exterior / hardscape","Commercial tenant improvement","Windows","Other"].map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <button onClick={() => saveEdit(lead.id, "project_type")} className="bg-orange text-white px-2 rounded text-[10px] font-bold">✓</button>
                        <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-red-500 text-[10px]">✕</button>
                      </div>
                    ) : (
                      <span className="text-gray-700 font-medium">{lead.project_type || "—"}</span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {lead.phone
                      ? <a href={`tel:${lead.phone}`} className="text-[#0091ae] hover:underline text-[12px]">{lead.phone}</a>
                      : <span className="text-[12px] text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {lead.email
                      ? <a href={`mailto:${lead.email}`} className="text-[#0091ae] hover:underline text-[12px] truncate block max-w-[160px]">{lead.email}</a>
                      : <span className="text-[12px] text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-gray-700 cursor-pointer hover:bg-blue-50" onClick={() => startEdit(lead.id, "city", lead.city)}>
                    {editing?.id === lead.id && editing?.field === "city" ? (
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <input type="text" className="border border-blue-300 rounded px-2 py-0.5 text-xs flex-1 text-slate-900 font-semibold bg-white" value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus />
                        <button onClick={() => saveEdit(lead.id, "city")} className="bg-orange text-white px-2 rounded text-[10px] font-bold">✓</button>
                        <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-red-500 text-[10px]">✕</button>
                      </div>
                    ) : (
                      <span className="text-gray-700 font-medium">{lead.city || "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 cursor-pointer hover:bg-blue-50" onClick={() => startEdit(lead.id, "status", lead.status)}>
                    {editing?.id === lead.id && editing?.field === "status" ? (
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <select className="border border-blue-300 rounded px-2 py-0.5 text-xs text-slate-900 font-semibold bg-white" value={editValue} onChange={async (e) => { setEditValue(e.target.value); await handleStatusChange(lead.id, e.target.value); }} autoFocus>
                          {["New","Appointment scheduled","Answered, no appointment set","No answer","Proposal Sent","No show","DNQ","Sold","Lost"].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    ) : (
                      <span className={`text-[12px] font-medium ${STATUS_COLOR[lead.status] || "text-gray-700"}`}>
                        {lead.status || "New"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-gray-700">
                    {lead.assigned_rep
                      ? <span className="truncate max-w-[100px] block">{lead.assigned_rep.split("@")[0]}</span>
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="bg-white border-t border-gray-200 px-4 py-2 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="flex items-center gap-1 px-2.5 py-1 text-[12px] border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-gray-600"
        >
          <ChevronLeft className="w-3 h-3" /> Prev
        </button>
        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const n = i + 1;
            return (
              <button key={n} onClick={() => setPage(n)}
                className={`w-7 h-7 text-[12px] rounded border transition-colors
                  ${page === n ? "bg-[#0091ae] text-white border-[#0091ae]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                {n}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="flex items-center gap-1 px-2.5 py-1 text-[12px] border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-gray-600"
        >
          Next <ChevronRight className="w-3 h-3" />
        </button>
        <span className="text-[11px] text-gray-500 ml-1">
          {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length} · {PAGE_SIZE} per page
        </span>
      </div>
    </div>
  );
}

function ColHeader({ label, field, current, dir, onClick }) {
  const active = current === field;
  return (
    <th
      className="text-left px-3 py-2.5 cursor-pointer select-none group whitespace-nowrap"
      onClick={() => onClick(field)}
    >
      <div className="flex items-center gap-1">
        <span className={`text-[11px] font-semibold tracking-wide transition-colors
          ${active ? "text-[#0091ae]" : "text-gray-500 group-hover:text-gray-800"}`}>
          {label}
        </span>
        <span className="flex flex-col">
          {active && dir === "asc"
            ? <ChevronUp className="w-3 h-3 text-[#0091ae]" />
            : active && dir === "desc"
            ? <ChevronDown className="w-3 h-3 text-[#0091ae]" />
            : <ChevronDown className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100" />
          }
        </span>
      </div>
    </th>
  );
}