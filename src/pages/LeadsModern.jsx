import { useState, useEffect, useCallback, useRef } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwaySettings from "@/api/railway/settings";
import { useAuth } from "@/lib/AuthContext";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Plus, Search, Phone, Mail, MapPin, ArrowRight, User, CheckCircle, RefreshCw, ExternalLink, AlertCircle, Calendar, Trash2 } from "lucide-react";
import { sortActiveLeads, parseFollowUpDate, getTodayLocal } from "@/lib/sortActiveLeads";
import { STATUS_STYLES, statusBadgeClass } from "@/lib/design-system";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { isActiveSalesLead } from "@/lib/activeLeadFilter";
import PullToRefreshIndicator from "@/components/PullToRefreshIndicator";
import ContactActions from "@/components/ContactActions";
import TruncatedTooltip from "@/components/TruncatedTooltip";
import { callPhone } from "@/lib/contactActions";
import DragStatusOverlay, { STATUSES } from "@/components/DragStatusOverlay";

function fmtCreateDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Email → display name mapping for sales reps
const USER_OWNER_MAP = {
  'yaron@ecconstructiongroup.com': 'Yaron Drilevich',
  'yaron.ecrenewables@gmail.com': 'Yaron Drilevich',
  'ethan@ecconstructiongroup.com': 'Ethan Magen',
  'micky@ecconstructiongroup.com': 'Micky Gad',
  'michelle@ecconstructiongroup.com': 'Michelle Roitman Drilevich',
  'matt@ecconstructiongroup.com': 'Matt Aharoni',
  'karen@ecconstructiongroup.com': 'Karen Hirschorn',
  'michelle.roitman@ecconstructiongroup.com': 'Michelle Roitman Drilevich',
};

export default function LeadsModern() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  // Read ?status= from URL on mount (e.g. when navigating from Reports)
  const urlParams = new URLSearchParams(location.search);
  const initialStatus = urlParams.get('status') || 'all';
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [sortField, setSortField] = useState("follow_up");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [contactOwners, setContactOwners] = useState([]);
  const [newWebsiteLeadsCount, setNewWebsiteLeadsCount] = useState(0);
  const [userRole, setUserRole] = useState(null);
  const [userOwner, setUserOwner] = useState(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Drag-to-status state
  const [dragState, setDragState] = useState(null); // { lead, ghostPos, hoveredStatus }
  const [dragToast, setDragToast] = useState(null); // { message, type }
  const dragToastTimer = useRef(null);

  const showDragToast = (message, type = "success") => {
    setDragToast({ message, type });
    clearTimeout(dragToastTimer.current);
    dragToastTimer.current = setTimeout(() => setDragToast(null), 3000);
  };

  const handleDragStart = (lead, e) => {
    setDragState({ lead, ghostPos: { x: e.clientX, y: e.clientY }, hoveredStatus: null });
  };

  const handleDragEnd = useCallback(async (droppedStatus) => {
    const lead = dragState?.lead;
    setDragState(null);
    if (!droppedStatus || !lead || droppedStatus === lead.status) return;
    try {
      const updated = await railwayLeads.update(lead.id, { status: droppedStatus });
      setLeads(prev => prev.map(l => l.id === lead.id ? updated : l));
      showDragToast(`${toTitleCase(lead.first_name)} ${toTitleCase(lead.last_name)} → ${droppedStatus}`);
    } catch (e) {
      showDragToast(e.message || "Failed to update status. Try again.", "error");
    }
  }, [dragState]);

  // Track mouse position for ghost card
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e) => {
      setDragState(prev => prev ? { ...prev, ghostPos: { x: e.clientX, y: e.clientY } } : null);
    };
    const onUp = () => {
      handleDragEnd(dragState?.hoveredStatus);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragState, handleDragEnd]);

  // Store resolved user in a ref so callbacks always have the latest value
  const resolvedUserRef = useRef(null);

  useEffect(() => {
    const withTimeout = (promise, ms, label) => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms/1000}s`)), ms)
      );
      return Promise.race([promise, timeout]);
    };

    if (!user) return; // Wait for auth to load the user
    const init = async () => {
      try {
        // Load settings in parallel but don't block on failure
        withTimeout(
          railwaySettings.get('app_lists'),
          5000, 'Settings'
        ).then(setting => {
          if (setting?.value?.contactOwners) {
            setContactOwners(setting.value.contactOwners);
          }
        }).catch(() => {});

        resolvedUserRef.current = user;
        setUserRole(user.role);
        setUserOwner(USER_OWNER_MAP[user.email] || user.full_name);
        if (user.role === 'admin' || user.role === 'manager') {
          const sessionPref = sessionStorage.getItem(`ownerFilter_${user.email}`);
          setOwnerFilter(sessionPref || 'all');
        } else {
          setOwnerFilter('__mine__');
        }
        setUserLoaded(true);
        await loadLeads(user);
      } catch (e) {
        console.error('[Leads] init error:', e.message);
        setLoadError(e.message || 'Failed to load. Please refresh.');
        setLoading(false);
        setUserLoaded(true);
      }
    };
    init();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadLeads(resolvedUserRef.current);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let debounceTimer = null;
    let lastReload = 0;
    // No Base44 realtime subscribe — rely on visibility-change polling + pull-to-refresh
    return () => {
      clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user]);

  useEffect(() => {
    if (resolvedUserRef.current) loadLeads(resolvedUserRef.current);
  }, [location.key]);

  const loadLeads = useCallback(async (user) => {
    try {
      // Railway API: owner-scoped list (admin/manager: all, sales_rep: own only)
      const res = await railwayLeads.list({ sort: '-updated_date', limit: 2000 });
      const allLeads = res.items || [];

      const filtered = allLeads.filter(lead =>
        !lead.first_name?.toLowerCase().includes('unknown') &&
        !lead.last_name?.toLowerCase().includes('unknown')
      );

      setLeads(filtered);
      setLoadError(null);
      setLoading(false);
    } catch (e) {
      console.error('[Leads] loadLeads error:', e.message);
      setLoadError(e.message || 'Failed to load leads. Tap to retry.');
      setLoading(false);
    }
  }, []);

  const { pulling, refreshing, pullDistance } = usePullToRefresh(loadLeads);

  const isGlobalSearch = searchTerm.trim().length > 0;
  const mineNameLower = userOwner ? userOwner.trim().toLowerCase().replace(/\s+/g, ' ') : null;

  const baseFiltered = leads
    .filter(lead => {
      if (isGlobalSearch) {
        const searchText = `${lead.first_name} ${lead.last_name} ${lead.email || ''} ${lead.phone || ''} ${lead.city || ''} ${lead.property_address || ''} ${lead.assigned_rep || ''} ${lead.project_type || ''} ${lead.notes || ''}`.toLowerCase();
        return searchText.includes(searchTerm.toLowerCase());
      }
      // If a specific status filter is set, don't exclude any statuses — show exactly what's filtered
      if (statusFilter !== 'all') return true;
      // Default: show only active leads
      return isActiveSalesLead(lead);
    })
    .filter(lead => {
      if (isGlobalSearch) return true;
      return statusFilter === 'all' || lead.status === statusFilter;
    })
    .filter(lead => {
      if (isGlobalSearch) return true;
      return sourceFilter === 'all' || lead.source === 'Website';
    })
    .filter(lead => {
    // sales_rep: RLS already scopes to their assigned leads, skip owner filter
    if (userRole === 'sales_rep') return true;
      if (isGlobalSearch) return true;
      if (ownerFilter === 'all') return true;
      if (ownerFilter === 'unassigned') return !lead.assigned_rep || lead.assigned_rep.trim() === '';
      if (ownerFilter === '__mine__') {
        if (!mineNameLower) return false;
        return (lead.assigned_rep || '').trim().toLowerCase().replace(/\s+/g, ' ') === mineNameLower;
      }
      return lead.assigned_rep?.trim().toLowerCase() === ownerFilter.toLowerCase();
    });

  const filteredLeads = sortField === "follow_up"
    ? sortActiveLeads(baseFiltered)
    : [...baseFiltered].sort((a, b) => {
        if (sortField === "created") {
          return new Date(b.crm_created_date || b.created_date || 0) - new Date(a.crm_created_date || a.created_date || 0);
        }
        if (sortField === "updated") {
          return new Date(b.updated_date || 0) - new Date(a.updated_date || 0);
        }
        return 0;
      });

  const soldRevenue = leads
    .filter(lead => lead.status === 'Sold')
    .reduce((sum, lead) => sum + (lead.estimated_value || 0), 0);

  return (
    <div className="min-h-screen bg-background">
      <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />

      {/* Drag-to-status overlay */}
      {dragState && (
        <DragStatusOverlay
          lead={dragState.lead}
          ghostPos={dragState.ghostPos}
          hoveredStatus={dragState.hoveredStatus}
          onStatusHover={(s) => setDragState(prev => prev ? { ...prev, hoveredStatus: s } : null)}
        />
      )}

      {/* Drag success/error toast */}
      {dragToast && (
        <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-2 px-5 py-3 rounded-2xl shadow-2xl text-sm font-semibold pointer-events-none transition-all ${
          dragToast.type === "error" ? "bg-red-600 text-white" : "bg-slate-900 text-white"
        }`}>
          {dragToast.type === "error" ? "⚠️" : "✓"} {dragToast.message}
        </div>
      )}

      {/* Sticky Header */}
      <div className="sticky top-0 z-40 bg-card border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">
                {statusFilter !== 'all' ? `${statusFilter} Leads` : 'Active Leads'}
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {userLoaded ? `${filteredLeads.length} lead${filteredLeads.length !== 1 ? 's' : ''}` : 'Loading…'}
                {statusFilter !== 'all' && (
                  <button onClick={() => setStatusFilter('all')} className="ml-2 text-amber-600 hover:text-amber-800 font-semibold underline text-xs">
                    Clear filter
                  </button>
                )}
              </p>
            </div>
            <Link
              to="/capture?returnToCRM=true"
              className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors active:scale-95 shadow-sm"
            >
              <Plus className="w-4 h-4" />
              New Lead
            </Link>
          </div>

          {/* Tabs: All vs Website */}
          <div className="flex gap-1 mb-4 border-b border-slate-200">
            <button
              onClick={() => setSourceFilter('all')}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${sourceFilter === 'all' ? 'border-amber-600 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              All Leads
            </button>
            <button
              onClick={() => setSourceFilter('website')}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-all relative ${sourceFilter === 'website' ? 'border-amber-600 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              Website Leads
              {newWebsiteLeadsCount > 0 && (
                <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
              )}
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search name, email, phone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all w-64"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm font-medium bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all w-auto"
            >
              <option value="all">All Statuses</option>
              {Object.keys(STATUS_STYLES).map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>

            {(userRole === 'admin' || userRole === 'manager') && (
              <select
                value={ownerFilter}
                onChange={e => {
                  const newValue = e.target.value;
                  setOwnerFilter(newValue);
                  if (user) sessionStorage.setItem(`ownerFilter_${user.email}`, newValue);
                }}
                className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm font-medium bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 w-auto"
              >
                <option value="all">All Leads</option>
                {contactOwners.map(owner => (
                  <option key={owner} value={owner}>{owner}</option>
                ))}
                <option value="unassigned">Unassigned</option>
              </select>
            )}
            <select
              value={sortField}
              onChange={e => setSortField(e.target.value)}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm font-medium bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 w-auto"
            >
              <option value="follow_up">Sort: Follow-up Date</option>
              <option value="created">Sort: Create Date ↓</option>
              <option value="updated">Sort: Last Updated ↓</option>
            </select>
          </div>
        </div>
      </div>

      {/* Leads List */}
      <div className="max-w-7xl mx-auto px-6 py-6">

        {isGlobalSearch && filteredLeads.length > 0 && (
          <div className="mb-4 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-xs font-semibold text-blue-700">
            🔍 Showing results from all leads ({filteredLeads.length} match{filteredLeads.length !== 1 ? 'es' : ''})
          </div>
        )}

        {loading || !userLoaded ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
            <p className="text-xs text-slate-400">Loading leads…</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4 text-center px-6">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <div>
              <p className="text-sm font-semibold text-slate-700">Could not load leads</p>
              <p className="text-xs text-slate-400 mt-1">{loadError}</p>
            </div>
            <button
              onClick={() => { setLoading(true); setLoadError(null); loadLeads(resolvedUserRef.current); }}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <p className="text-sm">{isGlobalSearch ? 'No leads match your search' : 'No leads match your filters'}</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredLeads.map(lead => (
              <LeadCard
                key={lead.id}
                lead={lead}
                navigate={navigate}
                userRole={userRole}
                onLeadUpdate={(updated) => setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))}
                onDeleted={(id) => { setLeads(prev => prev.filter(l => l.id !== id)); showDragToast("Lead deleted."); }}
                onDragStart={(e) => handleDragStart(lead, e)}
                isDragging={dragState?.lead?.id === lead.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function getFollowUpStatus(date) {
  if (!date) return null;
  const dateNum = parseFollowUpDate(date);
  if (dateNum === null) return null;
  const todayNum = getTodayLocal();
  if (dateNum < todayNum) return 'overdue';
  if (dateNum === todayNum) return 'today';
  return 'upcoming';
}

function LabeledField({ icon, label, value, muted = false }) {
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-slate-400">{icon}</span>
      <span className="font-semibold text-slate-500">{label}:</span>
      <span className={muted ? 'text-slate-300 italic' : 'text-slate-700'}>{value}</span>
    </span>
  );
}

function DateField({ label, date }) {
  if (!date) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="font-semibold text-slate-400">{label}:</span>
        <span className="text-slate-300 italic">—</span>
      </span>
    );
  }
  const match = String(date).match(/(\d{4})-(\d{2})-(\d{2})/);
  const dateNum = match ? parseInt(match[1]) * 10000 + parseInt(match[2]) * 100 + parseInt(match[3]) : null;
  const todayNum = getTodayLocal();
  const isPast = dateNum !== null && dateNum < todayNum;
  const isToday = dateNum !== null && dateNum === todayNum;
  const formatted = match
    ? new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : date;
  const valueClass = isToday ? 'text-amber-600 font-bold' : isPast ? 'text-slate-400 font-normal' : 'text-slate-700 font-semibold';
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="font-semibold text-slate-400">{label}:</span>
      <span className={valueClass}>{isToday ? 'Today' : formatted}</span>
    </span>
  );
}

function LeadCard({ lead, navigate, onLeadUpdate, onDragStart, isDragging, userRole, onDeleted }) {
  const mouseDownPos = useRef(null);
  const didDrag = useRef(false);
  const [completing, setCompleting] = useState(false);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [confirmingStatus, setConfirmingStatus] = useState(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDelete = userRole === 'admin' || userRole === 'manager';
  const linkedRecords = [
    lead.qb_customer_id && 'QuickBooks',
    lead.qb_invoice_id && 'QuickBooks invoice',
    (lead.handoff_project_id || lead.handoff_project_number) && 'Handoff',
    lead.signed_contract_document_id && 'Signed document',
  ].filter(Boolean);
  const hasLinkedRecords = linkedRecords.length > 0;
  const fuStatus = getFollowUpStatus(lead.follow_up_date);
  const hasFollowUp = !!lead.follow_up_date;
  const isPhoneCall = lead.follow_up_type === 'Phone Call';
  const isMeeting = lead.follow_up_type === 'Meeting';

  const match = lead.follow_up_date ? String(lead.follow_up_date).match(/(\d{4})-(\d{2})-(\d{2})/) : null;
  const formattedDate = match
    ? new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : lead.follow_up_date;

  const badgeClass = fuStatus === 'overdue'
    ? 'bg-red-100 text-red-700 border border-red-300'
    : fuStatus === 'today'
    ? 'bg-amber-100 text-amber-700 border border-amber-300 font-bold'
    : 'bg-slate-100 text-slate-600 border border-slate-200';

  const handleComplete = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setCompleting(true);
    try {
      const updated = await railwayLeads.update(lead.id, {
        follow_up_date: null, follow_up_time: null, follow_up_type: null,
      });
      onLeadUpdate(updated);
    } catch (e) {
      console.error('[LeadsModern] Failed to clear follow-up:', e?.message);
    } finally {
      setCompleting(false);
    }
  };

  const majorStatusChanges = ['Closed Lost', 'DNQ', 'Sold', 'Lost', 'Closed'];

  const handleStatusChange = (newStatus) => {
    if (majorStatusChanges.includes(newStatus)) {
      setConfirmingStatus(newStatus);
      setStatusDropdownOpen(false);
      return;
    }
    updateLeadStatus(newStatus);
  };

  const updateLeadStatus = async (newStatus) => {
    setUpdatingStatus(true);
    try {
      const updated = await railwayLeads.update(lead.id, { status: newStatus });
      onLeadUpdate(updated);
      setStatusDropdownOpen(false);
      setConfirmingStatus(null);
    } catch (e) {
      console.error('Error updating status:', e);
      alert(`Could not update status: ${e.message}`);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const deletingRef = useRef(false);
  const handleDeleteLead = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (deletingRef.current) return; // ignore second delete request for same lead
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await railwayLeads.remove(lead.id);
      if (res.success) {
        setConfirmingDelete(false);
        onDeleted?.(lead.id);
        return;
      }
      throw new Error('Delete failed');
    } catch (err) {
      const status = err?.status;
      // 404 = already deleted → treat as success
      if (status === 404) {
        setConfirmingDelete(false);
        onDeleted?.(lead.id);
        return;
      }
      // 500 / network error → reconcile with one read-only re-fetch
      if (!status || status === 500) {
        try {
          await railwayLeads.get(lead.id);
          // Still exists → genuine failure
          alert("Failed to delete lead: " + (err.message || "You may not have permission."));
        } catch (refetchErr) {
          // Re-fetch failed (lead gone) → deletion succeeded
          setConfirmingDelete(false);
          onDeleted?.(lead.id);
        }
      } else {
        // 403 / 400 / other → real error
        alert("Failed to delete lead: " + (err.message || "You may not have permission."));
      }
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const colors = ['bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-green-500', 'bg-orange-500', 'bg-cyan-500'];
  const avatarColor = colors[lead.id.charCodeAt(0) % colors.length];

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, [role="button"]')) return;
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    didDrag.current = false;

    const onMove = (me) => {
      const dx = me.clientX - mouseDownPos.current.x;
      const dy = me.clientY - mouseDownPos.current.y;
      if (!didDrag.current && Math.sqrt(dx * dx + dy * dy) > 6) {
        didDrag.current = true;
        onDragStart?.(me);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleClick = (e) => {
    if (didDrag.current) {
      e.preventDefault();
    }
  };

  return (
    <Link
      to={`/leads/${lead.external_ref || lead.id}`}
      draggable={false}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={`bg-white rounded-lg border shadow-sm hover:shadow-lg hover:border-amber-300 transition-all duration-200 px-4 py-3 group block select-none ${
        isDragging ? 'opacity-50 scale-[0.98] border-amber-400 border-2' :
        lead.is_new_intake_lead ? 'border-amber-400 border-2 shadow-amber-100 cursor-grab' : 'border-slate-200 cursor-grab'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-md ${avatarColor} flex items-center justify-center text-white font-bold text-xs flex-shrink-0 mt-0.5`}>
          {`${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + Status */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap relative pointer-events-none">
            <TruncatedTooltip text={`${toTitleCase(lead.first_name)} ${toTitleCase(lead.last_name)}`} className="text-sm font-semibold text-slate-900" />
            <div className="relative">
              <span
                role="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setStatusDropdownOpen(!statusDropdownOpen); }}
                className={`${statusBadgeClass(lead.status)} cursor-pointer hover:opacity-80 transition-opacity btn-compact`}
              >
                {lead.status}
              </span>
              {statusDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-lg z-50 p-1 max-h-64 overflow-y-auto">
                  {Object.keys(STATUS_STYLES).map(status => (
                    <button
                      key={status}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleStatusChange(status); }}
                      disabled={updatingStatus}
                      className={`w-full text-left px-3 py-2 text-xs font-medium rounded transition-colors whitespace-nowrap ${status === lead.status ? 'bg-amber-50 text-amber-700 font-semibold' : 'text-slate-700 hover:bg-slate-100'} disabled:opacity-50`}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {lead.estimated_value > 0 && (
              <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full leading-tight">
                ${lead.estimated_value.toLocaleString()}
              </span>
            )}
          </div>

          {/* Confirmation Dialog */}
          {confirmingStatus && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <div className="bg-white rounded-lg shadow-lg p-5 max-w-sm mx-4" onClick={(e) => e.preventDefault()}>
                <div className="flex items-start gap-3 mb-4">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Move to {confirmingStatus}?</h3>
                    <p className="text-xs text-slate-600 mt-1">This will change the lead status and remove it from your Active Leads list.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); updateLeadStatus(confirmingStatus); }}
                    disabled={updatingStatus}
                    className="flex-1 px-3 py-2 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
                  >
                    {updatingStatus ? 'Updating...' : 'Confirm'}
                  </button>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmingStatus(null); }}
                    className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Delete confirmation dialog */}
          {confirmingDelete && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmingDelete(false); }}>
              <div className="bg-white rounded-lg shadow-lg p-5 max-w-sm mx-4" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                <div className="flex items-start gap-3 mb-4">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="text-sm font-bold text-slate-900">Delete Lead?</h3>
                    <p className="text-xs text-slate-600 mt-1">This action cannot be undone.</p>
                    {hasLinkedRecords && (
                      <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-xs font-semibold text-amber-800 mb-1">⚠ This lead is linked to:</p>
                        <ul className="text-xs text-amber-700 list-disc list-inside">
                          {linkedRecords.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                        <p className="text-[11px] text-amber-700 mt-1.5">Deleting the lead will not remove these records from QuickBooks, Handoff, or SignNow.</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteLead}
                    disabled={deleting}
                    className="flex-1 px-3 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmingDelete(false); }}
                    className="flex-1 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Contact + Location */}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mb-1.5">
            {lead.phone && <LabeledField icon={<Phone className="w-3 h-3 text-green-600" />} label="Phone" value={formatPhone(lead.phone)} />}
            {lead.email && (
              <div className="flex items-center gap-1" onClick={e => e.preventDefault()}>
                <Mail className="w-3 h-3 text-slate-400" />
                <a
                  href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.email)}`}
                  target="_blank"
                  rel="noopener"
                  onClick={e => e.stopPropagation()}
                  className="text-xs text-blue-600 hover:underline max-w-[160px] truncate block"
                  title={lead.email}
                >
                  {lead.email}
                </a>
              </div>
            )}
            {lead.city && <LabeledField icon={<MapPin className="w-3 h-3" />} label="City" value={toTitleCase(lead.city)} />}
            <LabeledField icon={<User className="w-3 h-3" />} label="Owner" value={toTitleCase(lead.assigned_rep) || '—'} muted={!lead.assigned_rep} />
            {(lead.crm_created_date || lead.created_date) && (
              <LabeledField icon={<Calendar className="w-3 h-3" />} label="Created" value={fmtCreateDate(lead.crm_created_date || lead.created_date)} />
            )}
          </div>

          {/* Follow-up row */}
          {hasFollowUp ? (
            <div className="mt-1 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500 font-semibold">Follow-up:</span>
                <span className="text-xs text-slate-700 font-semibold">
                  {fuStatus === 'today' ? 'Today' : formattedDate}
                  {lead.follow_up_time ? ` • ${fmt12(lead.follow_up_time)}` : ''}
                </span>
                <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-1 ${badgeClass}`}>
                  {isMeeting ? '📅' : '📞'}
                  {fuStatus === 'overdue' ? 'Overdue' : fuStatus === 'today' ? 'Due Today' : (lead.follow_up_type || 'Follow-up')}
                </span>
              </div>
              <div className="flex gap-1 flex-wrap items-center" onClick={e => e.preventDefault()}>
                <ContactActions phone={lead.phone} email={lead.email} size="sm" />
                {isMeeting && (
                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/leads/${lead.external_ref || lead.id}`); }}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors btn-compact">
                    <ExternalLink className="w-3 h-3" /> Calendar
                  </button>
                )}
                <button onClick={handleComplete} disabled={completing}
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors disabled:opacity-50 btn-compact">
                  <CheckCircle className="w-3 h-3" /> {isMeeting ? 'Done' : 'Complete'}
                </button>
                <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/leads/${lead.external_ref || lead.id}`); }}
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 transition-colors btn-compact">
                  <RefreshCw className="w-3 h-3" /> Reschedule
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
              <DateField label="Appointment" date={lead.appointment_date} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 mt-1">
          {canDelete && (
            <button
              type="button"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!deleting) setConfirmingDelete(true); }}
              className="p-1.5 rounded text-slate-300 hover:text-red-600 hover:bg-red-50 transition-colors btn-compact disabled:opacity-40 disabled:pointer-events-none"
              title="Delete lead"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-amber-500 transition-colors" />
        </div>
      </div>
    </Link>
  );
}