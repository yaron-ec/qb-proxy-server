import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";
import * as railwaySettings from "@/api/railway/settings";
import { Link, useNavigate } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { toTitleCase, formatPhone } from "@/lib/formatters";
import { Plus, Phone, User, MapPin, AlertCircle, RefreshCw, CheckCircle2, ExternalLink } from "lucide-react";

// ── Column definitions ─────────────────────────────────────────────────────
const COLUMNS = [
  { id: "New",                          label: "New",                          color: "#64748b", bg: "#f8fafc", activeDropBg: "#e2e8f0", headerBg: "#e2e8f0", headerText: "#334155" },
  { id: "No answer",                    label: "No Answer",                    color: "#94a3b8", bg: "#f8fafc", activeDropBg: "#e2e8f0", headerBg: "#e2e8f0", headerText: "#475569" },
  { id: "Answered, no appointment set", label: "Answered",                     color: "#d97706", bg: "#fffbeb", activeDropBg: "#fde68a", headerBg: "#fef3c7", headerText: "#92400e" },
  { id: "Appointment scheduled",        label: "Appt Scheduled",               color: "#2563eb", bg: "#eff6ff", activeDropBg: "#bfdbfe", headerBg: "#dbeafe", headerText: "#1e40af" },
  { id: "No show",                      label: "No Show",                      color: "#f97316", bg: "#fff7ed", activeDropBg: "#fed7aa", headerBg: "#ffedd5", headerText: "#9a3412" },
  { id: "Proposal Sent",                label: "Proposal Sent",                color: "#7c3aed", bg: "#f5f3ff", activeDropBg: "#ddd6fe", headerBg: "#ede9fe", headerText: "#5b21b6" },
  { id: "Sold",                         label: "Sold ✓",                       color: "#16a34a", bg: "#f0fdf4", activeDropBg: "#bbf7d0", headerBg: "#dcfce7", headerText: "#14532d" },
  { id: "Lost",                         label: "Lost",                         color: "#dc2626", bg: "#fef2f2", activeDropBg: "#fecaca", headerBg: "#fee2e2", headerText: "#991b1b" },
  { id: "DNQ",                          label: "DNQ",                          color: "#ea580c", bg: "#fff7ed", activeDropBg: "#fed7aa", headerBg: "#ffedd5", headerText: "#9a3412" },
];

const MAJOR_STATUSES = new Set(["Sold", "Lost", "DNQ"]);

let toastTimer = null;

export default function KanbanBoard() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [contactOwners, setContactOwners] = useState([]);
  const [userRole, setUserRole] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [confirmDrop, setConfirmDrop] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [toast, setToast] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  const showToast = (message, type = "success") => {
    setToast({ message, type });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 3500);
  };

  const { user } = useAuth();

  useEffect(() => {
    (async () => {
      // Settings: fetch app_lists from Railway settings API (admin-only; non-admins get 403, don't block)
      try {
        const settingsRes = await railwaySettings.get("app_lists");
        if (settingsRes?.value?.contactOwners) setContactOwners(settingsRes.value.contactOwners);
      } catch { /* non-admin or not configured */ }
      if (user) {
        setUserRole(user.role);
        if (user.role === "sales_rep") setOwnerFilter("__mine__");
      }
      await loadLeads();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLeads = async () => {
    setLoading(true);
    try {
      const res = await railwayLeads.list({ limit: 2000 });
      const all = (res.items || []).filter(l =>
        l.record_type !== "Contact" &&
        l.first_name && !l.first_name.toLowerCase().includes("unknown")
      );
      setLeads(all);
    } catch {
      setLeads([]);
    } finally {
      setLoading(false);
    }
  };

  const visibleLeads = leads.filter(l => {
    const matchesOwner = ownerFilter === "all" || ownerFilter === "__mine__" ||
      (l.assigned_rep || "").toLowerCase() === ownerFilter.toLowerCase();
    const matchesSearch = !searchTerm ||
      `${l.first_name} ${l.last_name} ${l.phone || ""} ${l.city || ""}`.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesOwner && matchesSearch;
  });

  const getColLeads = (statusId) =>
    visibleLeads
      .filter(l => (l.status || "New") === statusId)
      .sort((a, b) => new Date(b.crm_created_date || b.created_date || 0) - new Date(a.crm_created_date || a.created_date || 0));

  const doStatusUpdate = async (lead, newStatus) => {
    const oldStatus = lead.status || "New";
    setUpdating(lead.id);
    // Optimistic update
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: newStatus } : l));
    setConfirmDrop(null);
    try {
      await railwayLeads.update(lead.id, { status: newStatus });
      showToast(`${toTitleCase(lead.first_name)} ${toTitleCase(lead.last_name)} → ${newStatus}`);
    } catch (e) {
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: oldStatus } : l));
      showToast(e.message || "Failed to update. Try again.", "error");
    } finally {
      setUpdating(null);
    }
  };

  const onDragStart = ({ draggableId }) => setDraggingId(draggableId);

  const onDragEnd = ({ destination, source, draggableId }) => {
    setDraggingId(null);
    if (!destination || destination.droppableId === source.droppableId) return;
    const lead = leads.find(l => l.id === draggableId);
    if (!lead) return;
    const newStatus = destination.droppableId;
    if (MAJOR_STATUSES.has(newStatus)) {
      setConfirmDrop({ lead, newStatus });
    } else {
      doStatusUpdate(lead, newStatus);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full bg-slate-50">
      <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-[#f1f3f6] overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="bg-white border-b border-slate-200 px-5 py-3 flex-shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Pipeline</h1>
          <p className="text-xs text-slate-400">{visibleLeads.length} leads · drag cards across columns to change status</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/30 focus:border-amber-400 w-40"
          />
          {(userRole === "admin" || userRole === "manager") && (
            <select
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none"
            >
              <option value="all">All Reps</option>
              {contactOwners.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          <button onClick={loadLeads} className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link to="/leads/new" className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-3 py-1.5 rounded-lg transition-colors">
            <Plus className="w-4 h-4" /> New Lead
          </Link>
        </div>
      </div>

      {/* ── Board ── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex gap-3 p-4 h-full items-start" style={{ minWidth: `${COLUMNS.length * 230 + 32}px` }}>
            {COLUMNS.map(col => {
              const colLeads = getColLeads(col.id);
              return (
                <KanbanColumn
                  key={col.id}
                  col={col}
                  leads={colLeads}
                  updating={updating}
                  navigate={navigate}
                  draggingId={draggingId}
                  onStatusChange={(lead, newStatus) =>
                    MAJOR_STATUSES.has(newStatus)
                      ? setConfirmDrop({ lead, newStatus })
                      : doStatusUpdate(lead, newStatus)
                  }
                />
              );
            })}
          </div>
        </DragDropContext>
      </div>

      {/* ── Confirm major-status dialog ── */}
      {confirmDrop && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setConfirmDrop(null)}>
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-amber-600" />
            </div>
            <h3 className="text-base font-bold text-slate-900 text-center mb-2">Move to "{confirmDrop.newStatus}"?</h3>
            <p className="text-sm text-slate-500 text-center mb-5">
              <strong className="text-slate-800">{toTitleCase(confirmDrop.lead.first_name)} {toTitleCase(confirmDrop.lead.last_name)}</strong> will be marked as <strong>{confirmDrop.newStatus}</strong>.
            </p>
            <div className="flex gap-2">
              <button onClick={() => doStatusUpdate(confirmDrop.lead, confirmDrop.newStatus)}
                className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold rounded-xl transition-colors">
                Confirm
              </button>
              <button onClick={() => { setConfirmDrop(null); loadLeads(); }}
                className="flex-1 py-2.5 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-5 py-3 rounded-2xl shadow-2xl text-sm font-semibold pointer-events-none ${
          toast.type === "error" ? "bg-red-600 text-white" : "bg-slate-900 text-white"
        }`}>
          {toast.type === "error" ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────

function KanbanColumn({ col, leads, updating, navigate, draggingId, onStatusChange }) {
  const isActive = !!draggingId;

  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden flex-shrink-0 transition-all duration-150"
      style={{
        width: 220,
        background: col.bg,
        border: `2px solid ${isActive ? col.color + "66" : col.color + "33"}`,
        boxShadow: isActive ? `0 0 0 1px ${col.color}33` : "none",
      }}
    >
      {/* Column header */}
      <div
        className="px-3 py-2.5 flex items-center justify-between flex-shrink-0"
        style={{ background: col.headerBg }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: col.color }} />
          <span className="text-xs font-bold truncate" style={{ color: col.headerText }}>{col.label}</span>
        </div>
        <span className="text-xs font-bold rounded-full px-2 py-0.5 ml-2 flex-shrink-0"
          style={{ background: col.color + "22", color: col.color }}>
          {leads.length}
        </span>
      </div>

      {/* Drop area */}
      <Droppable droppableId={col.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="flex-1 overflow-y-auto transition-all duration-100"
            style={{
              minHeight: 80,
              padding: "8px 6px",
              background: snapshot.isDraggingOver ? col.activeDropBg : "transparent",
            }}
          >
            {/* Drop target indicator */}
            {snapshot.isDraggingOver && (
              <div
                className="rounded-lg border-2 border-dashed mb-2 py-3 flex flex-col items-center justify-center gap-1"
                style={{ borderColor: col.color, background: col.color + "15" }}
              >
                <div className="text-lg">↓</div>
                <span className="text-xs font-bold" style={{ color: col.color }}>Move here</span>
              </div>
            )}

            {/* Empty state — visible while dragging */}
            {!snapshot.isDraggingOver && leads.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 gap-1">
                {isActive ? (
                  <>
                    <div className="w-8 h-8 rounded-full border-2 border-dashed flex items-center justify-center"
                      style={{ borderColor: col.color + "66" }}>
                      <span style={{ color: col.color + "99" }}>+</span>
                    </div>
                    <span className="text-xs font-medium" style={{ color: col.color }}>Drop here</span>
                  </>
                ) : (
                  <span className="text-xs text-slate-400">No leads</span>
                )}
              </div>
            )}

            {/* Cards */}
            <div className="space-y-2">
              {leads.map((lead, index) => (
                <KanbanCard
                  key={lead.id}
                  lead={lead}
                  index={index}
                  isUpdating={updating === lead.id}
                  navigate={navigate}
                  onStatusChange={onStatusChange}
                  currentStatusId={col.id}
                  accentColor={col.color}
                />
              ))}
            </div>
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

function KanbanCard({ lead, index, isUpdating, navigate, onStatusChange, currentStatusId, accentColor }) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <Draggable draggableId={lead.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}  /* ← ENTIRE card is the drag handle */
          style={{
            ...provided.draggableProps.style,
            opacity: snapshot.isDragging ? 0.85 : 1,
            transform: snapshot.isDragging
              ? `${provided.draggableProps.style?.transform || ""} rotate(2deg)`
              : provided.draggableProps.style?.transform,
          }}
          className="bg-white rounded-lg select-none transition-shadow"
          style={{
            ...provided.draggableProps.style,
            opacity: snapshot.isDragging ? 0.88 : 1,
            cursor: snapshot.isDragging ? "grabbing" : "grab",
            boxShadow: snapshot.isDragging
              ? `0 16px 40px rgba(0,0,0,0.2), 0 0 0 2px ${accentColor}`
              : "0 1px 3px rgba(0,0,0,0.08)",
            border: snapshot.isDragging ? `2px solid ${accentColor}` : "1px solid #e2e8f0",
            transform: snapshot.isDragging
              ? `${provided.draggableProps.style?.transform || ""} rotate(1.5deg) scale(1.02)`
              : provided.draggableProps.style?.transform,
          }}
        >
          {/* Top accent bar */}
          <div className="h-1 rounded-t-lg" style={{ background: accentColor }} />

          {/* Card content */}
          <div className="p-3">
            {/* Name row */}
            <div className="flex items-start justify-between gap-1 mb-2">
              <p className="text-xs font-bold text-slate-900 leading-snug" title={`${toTitleCase(lead.first_name)} ${toTitleCase(lead.last_name)}`}>
                {toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}
              </p>
              {/* Open lead button (prevents drag conflict via stopPropagation) */}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                className="text-slate-300 hover:text-amber-500 flex-shrink-0 mt-0.5 transition-colors"
                title="Open lead"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>

            {/* Project type tag */}
            {lead.project_type && (
              <div className="mb-2">
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                  style={{ background: accentColor + "15", color: accentColor }}>
                  {lead.project_type}
                </span>
              </div>
            )}

            {/* Meta rows */}
            <div className="space-y-1">
              {lead.phone && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <Phone className="w-2.5 h-2.5 flex-shrink-0 text-slate-400" />
                  {formatPhone(lead.phone)}
                </div>
              )}
              {lead.city && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <MapPin className="w-2.5 h-2.5 flex-shrink-0 text-slate-400" />
                  <span className="truncate" title={toTitleCase(lead.city)}>{toTitleCase(lead.city)}</span>
                </div>
              )}
              {lead.assigned_rep && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <User className="w-2.5 h-2.5 flex-shrink-0 text-slate-400" />
                  <span className="truncate" title={toTitleCase(lead.assigned_rep)}>{toTitleCase(lead.assigned_rep)}</span>
                </div>
              )}
            </div>

            {/* Follow-up date */}
            {lead.follow_up_date && (
              <div className="mt-2 text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 inline-block">
                📅 {new Date(lead.follow_up_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
            )}

            {/* Saving indicator */}
            {isUpdating && (
              <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-600">
                <div className="w-2.5 h-2.5 border border-amber-500 border-t-transparent rounded-full animate-spin" />
                Saving…
              </div>
            )}
          </div>

          {/* Quick status change footer */}
          <div className="border-t border-slate-100 px-3 py-1.5 relative">
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setShowMenu(v => !v); }}
              className="w-full text-[10px] text-slate-400 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
            >
              Move to… ▾
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onMouseDown={e => e.stopPropagation()} onClick={() => setShowMenu(false)} />
                <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-white border border-slate-200 rounded-xl shadow-2xl py-1 overflow-hidden">
                  {COLUMNS.filter(c => c.id !== currentStatusId).map(c => (
                    <button
                      key={c.id}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); setShowMenu(false); onStatusChange(lead, c.id); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 text-left transition-colors"
                    >
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.color }} />
                      {c.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Draggable>
  );
}