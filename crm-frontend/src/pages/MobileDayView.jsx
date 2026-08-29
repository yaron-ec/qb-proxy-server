import React, { useState, useEffect, Suspense, Component } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";
import { Link } from "react-router-dom";
import { MapPin, Clock, Phone, Mail, MessageSquare, Navigation, Map as MapIcon, List, ChevronDown, ChevronUp, User, RefreshCw, Calendar, AlertTriangle } from "lucide-react";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import { geocodeAddress, fmt12, OWNER_COLORS } from "@/pages/DailyMap";

// Lazy-load MapView so a Leaflet import crash is isolated and doesn't kill the whole page
const MapView = React.lazy(() => import("@/components/dailymap/MapView"));

// Error boundary to catch crashes in MobileMapContainer (outside MapView's own boundary)
class MapPageErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error("[MobileDayView] Map section crashed:", error, info?.componentStack); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, background: "#f8fafc" }}>
          <AlertTriangle style={{ width: 40, height: 40, color: "#f59e0b" }} />
          <p style={{ fontWeight: 600, color: "#374151", textAlign: "center" }}>Map failed to load</p>
          <p style={{ fontSize: 12, color: "#6b7280", textAlign: "center" }}>{this.state.error?.message || "Unknown error"}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: "8px 20px", background: "#d97706", color: "white", borderRadius: 8, fontWeight: 600, fontSize: 13, border: "none" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const USER_OWNER_MAP = {
  'yaron@ecconstructiongroup.com': 'Yaron Drilevich',
  'ethan@ecconstructiongroup.com': 'Ethan Magen',
  'micky@ecconstructiongroup.com': 'Micky Gad',
  'michelle@ecconstructiongroup.com': 'Michelle Ecenski',
  'matt@ecconstructiongroup.com': 'Matt',
  'karen@ecconstructiongroup.com': 'Karen',
};

function getTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getTomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getNext7DaysLocal() {
  const dates = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  return dates;
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "";
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const DATE_FILTERS = [
  { label: "Today", value: "today" },
  { label: "Tomorrow", value: "tomorrow" },
  { label: "Next 7 Days", value: "week" },
];

function openNavigation(address) {
  const encoded = encodeURIComponent(address);
  // On iOS, prefer Apple Maps; on Android/others, Google Maps
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    window.open(`maps://maps.apple.com/?q=${encoded}`, "_blank");
  } else {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encoded}`, "_blank");
  }
}

function QuickActions({ appt }) {
  const address = [appt.property_address, appt.city, "CA"].filter(Boolean).join(", ");
  return (
    <div className="grid grid-cols-4 gap-2 mt-3 pt-3 border-t border-slate-100">
      {appt.phone && (
        <a
          href={`tel:${appt.phone}`}
          onClick={e => e.stopPropagation()}
          className="flex flex-col items-center gap-1 py-2 bg-emerald-50 rounded-xl border border-emerald-100 active:bg-emerald-100 transition-colors"
        >
          <Phone className="w-4 h-4 text-emerald-600" />
          <span className="text-[10px] font-bold text-emerald-700 uppercase">Call</span>
        </a>
      )}
      {appt.phone && (
        <a
          href={`sms:${appt.phone}`}
          onClick={e => e.stopPropagation()}
          className="flex flex-col items-center gap-1 py-2 bg-blue-50 rounded-xl border border-blue-100 active:bg-blue-100 transition-colors"
        >
          <MessageSquare className="w-4 h-4 text-blue-600" />
          <span className="text-[10px] font-bold text-blue-700 uppercase">SMS</span>
        </a>
      )}
      {appt.email && (
        <a
          href={`mailto:${appt.email}`}
          onClick={e => e.stopPropagation()}
          className="flex flex-col items-center gap-1 py-2 bg-violet-50 rounded-xl border border-violet-100 active:bg-violet-100 transition-colors"
        >
          <Mail className="w-4 h-4 text-violet-600" />
          <span className="text-[10px] font-bold text-violet-700 uppercase">Email</span>
        </a>
      )}
      {address && (
        <button
          onClick={e => { e.stopPropagation(); openNavigation(address); }}
          className="flex flex-col items-center gap-1 py-2 bg-amber-50 rounded-xl border border-amber-100 active:bg-amber-100 transition-colors"
        >
          <Navigation className="w-4 h-4 text-amber-600" />
          <span className="text-[10px] font-bold text-amber-700 uppercase">Navigate</span>
        </button>
      )}
    </div>
  );
}

function AppointmentCard({ appt, idx, isSelected, onSelect, ownerColor }) {
  const color = ownerColor || OWNER_COLORS["Unassigned"];
  const address = [appt.property_address, appt.city].filter(Boolean).join(", ");

  return (
    <div
      className={`rounded-2xl border-2 bg-white shadow-sm transition-all ${
        isSelected ? "border-amber-400 shadow-md" : "border-slate-200"
      }`}
      onClick={() => onSelect(isSelected ? null : appt.id)}
    >
      <div className="p-4">
        {/* Header: index + name + time */}
        <div className="flex items-start gap-3 mb-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
            style={{ background: color.bg }}
          >
            {idx + 1}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-slate-900 truncate">
                {toTitleCase(appt.first_name)} {toTitleCase(appt.last_name)}
              </p>
              <span className="text-xs font-bold text-slate-700 flex items-center gap-1 flex-shrink-0">
                <Clock className="w-3 h-3 text-amber-600" />
                {appt.follow_up_time ? fmt12(appt.follow_up_time) : (appt.appointment_time ? fmt12(appt.appointment_time) : "—")}
              </span>
            </div>

            {/* Rep */}
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color.bg }} />
              <span className="text-xs text-slate-500">{appt.assigned_rep || "Unassigned"}</span>
              <span className="text-slate-300 mx-1">·</span>
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
                appt.status === "Appointment scheduled" ? "bg-blue-100 text-blue-700" :
                appt.status === "Sold" ? "bg-emerald-100 text-emerald-700" :
                "bg-slate-100 text-slate-600"
              }`}>{appt.status || "—"}</span>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="ml-10 space-y-1">
          {address && (
            <div className="flex items-start gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
              <span className="text-xs text-slate-600">{address}</span>
            </div>
          )}
          {appt.project_type && (
            <div className="flex items-start gap-1.5">
              <span className="text-xs text-slate-400 ml-5">🏗️ {appt.project_type}</span>
            </div>
          )}
          {appt.phone && (
            <div className="flex items-start gap-1.5">
              <span className="text-xs text-slate-400 ml-5">📞 {formatPhone(appt.phone)}</span>
            </div>
          )}
        </div>

        {/* Quick Actions — always visible on mobile */}
        <QuickActions appt={appt} />

        {/* Expanded: Open Lead */}
        {isSelected && (
          <div className="ml-0 mt-3 pt-3 border-t border-slate-100">
            <Link
              to={`/leads/${appt.id}`}
              onClick={e => e.stopPropagation()}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-xl active:bg-slate-800 transition-colors"
            >
              Open Full Lead →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

// Wrapper that measures its own pixel height and passes it explicitly to Leaflet.
// This is necessary because Leaflet cannot resolve percentage heights when the
// flex parent collapses to 0 on mobile browsers.
// Fixed pixel height for the map panel — tall enough to be useful on mobile
const MAP_PANEL_HEIGHT = 320;

function MobileMapContainer({ appointments, selectedLead, onSelectLead, contactOwners, userRole }) {
  return (
    <div style={{ height: MAP_PANEL_HEIGHT, flexShrink: 0, position: "relative", background: "#fff", borderBottom: "1px solid #e2e8f0" }}>
      <Suspense fallback={
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc" }}>
          <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
        </div>
      }>
        <MapView
          appointments={appointments}
          selectedLead={selectedLead}
          onSelectLead={onSelectLead}
          onReassign={() => {}}
          contactOwners={contactOwners}
          userRole={userRole}
          explicitHeight={MAP_PANEL_HEIGHT}
        />
      </Suspense>
    </div>
  );
}

export default function MobileDayView() {
  const { user } = useAuth();
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const [appointments, setAppointments] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  const [dateFilter, setDateFilter] = useState("today");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [userRole, setUserRole] = useState(null);
  const [contactOwners, setContactOwners] = useState([]);
  const [view, setView] = useState("list"); // "list" | "map"

  useEffect(() => {
    const init = async () => {
      const me = user;
      setUserRole(me?.role);
      if (me?.role === "sales_rep") {
        const mapped = USER_OWNER_MAP[me.email] || me.full_name;
        if (mapped) setOwnerFilter(mapped);
      }
      // Railway API handles owner-scoping server-side (no RLS $in issue)
      const res = await railwayLeads.list({ limit: 2000 });
      setAllLeads(res.items || []);
      setLoading(false);
    };
    init();
  }, []);

  useEffect(() => {
    if (!allLeads.length) return;
    buildAppointments();
  }, [allLeads, dateFilter, ownerFilter]);

  const buildAppointments = async () => {
    const today = getTodayLocal();
    const tomorrow = getTomorrowLocal();
    const next7 = getNext7DaysLocal();
    // Match desktop exactly: same excluded statuses
    const excluded = ["Lost", "DNQ", "Cancelled", "Closed Lost"];

    // Match desktop: only follow_up_type === "Meeting" on follow_up_date, with an address
    const filtered = allLeads.filter(l => {
      if (l.follow_up_type !== "Meeting") return false;
      if (!l.follow_up_date) return false;
      if (!(l.property_address || l.city)) return false;
      if (excluded.includes(l.status)) return false;
      if (dateFilter === "today") return l.follow_up_date === today;
      if (dateFilter === "tomorrow") return l.follow_up_date === tomorrow;
      if (dateFilter === "week") return next7.includes(l.follow_up_date);
      return false;
    });

    const ownerFiltered = ownerFilter === "all"
      ? filtered
      : filtered.filter(l =>
          ownerFilter === "Unassigned"
            ? !l.assigned_rep
            : l.assigned_rep === ownerFilter
        );

    // Sort by time, same as desktop
    const sorted = [...ownerFiltered].sort((a, b) => {
      const ta = a.follow_up_time || "23:59";
      const tb = b.follow_up_time || "23:59";
      const da = a.follow_up_date || "";
      const db = b.follow_up_date || "";
      return da !== db ? da.localeCompare(db) : ta.localeCompare(tb);
    });

    // Build owners only from leads that actually have meetings (filtered set)
    const owners = [...new Set(filtered.filter(l => l.assigned_rep).map(l => l.assigned_rep))].sort();
    setContactOwners(owners);

    // Geocode for map view — same address format as desktop
    setGeocoding(true);
    const geocoded = await Promise.all(sorted.map(async (lead) => {
      const addrParts = [lead.property_address, lead.city, "CA"].filter(Boolean);
      const addr = addrParts.join(", ");
      let coords = null;
      let geocodeError = false;
      try {
        coords = await geocodeAddress(addr);
        if (!coords) geocodeError = true;
      } catch {
        geocodeError = true;
      }
      const ownerKey = lead.assigned_rep || "Unassigned";
      return {
        ...lead,
        coords,
        geocodeError,
        colorConfig: OWNER_COLORS[ownerKey] || OWNER_COLORS["Unassigned"],
        fullAddress: addr,
      };
    }));
    setGeocoding(false);
    setAppointments(geocoded);
  };

  // Group by date for week view
  const groupedByDate = dateFilter === "week"
    ? appointments.reduce((acc, appt) => {
        const d = appt.follow_up_date || appt.appointment_date || "unknown";
        if (!acc[d]) acc[d] = [];
        acc[d].push(appt);
        return acc;
      }, {})
    : null;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#f8fafc", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 pb-3 flex-shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-600" />
              My Day
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {appointments.length} appointment{appointments.length !== 1 ? "s" : ""}
              {geocoding && <span className="text-amber-600 ml-2">· mapping...</span>}
            </p>
          </div>
          {/* List / Map toggle */}
          <div className="flex border border-slate-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setView("list")}
              className={`px-3 py-2 text-xs font-bold transition-colors flex items-center gap-1 ${
                view === "list" ? "bg-amber-600 text-white" : "bg-white text-slate-500"
              }`}
            >
              <List className="w-3.5 h-3.5" /> List
            </button>
            <button
              onClick={() => setView("map")}
              className={`px-3 py-2 text-xs font-bold transition-colors flex items-center gap-1 ${
                view === "map" ? "bg-amber-600 text-white" : "bg-white text-slate-500"
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" /> Map
            </button>
          </div>
        </div>

        {/* Date filter pills */}
        <div className="flex gap-2 mb-2">
          {DATE_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setDateFilter(f.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border ${
                dateFilter === f.value
                  ? "bg-amber-600 text-white border-amber-600"
                  : "bg-white text-slate-600 border-slate-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Owner filter — hidden for sales_rep */}
        {userRole !== "sales_rep" && contactOwners.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
            <button
              onClick={() => setOwnerFilter("all")}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-bold border transition-all ${
                ownerFilter === "all" ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-500 border-slate-200"
              }`}
            >
              All Reps
            </button>
            {contactOwners.map(owner => {
              const cfg = OWNER_COLORS[owner];
              return (
                <button
                  key={owner}
                  onClick={() => setOwnerFilter(owner)}
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border-2 transition-all"
                  style={{
                    background: ownerFilter === owner ? cfg?.bg || "#374151" : "white",
                    color: ownerFilter === owner ? "white" : "#374151",
                    borderColor: cfg?.bg || "#374151",
                  }}
                >
                  {cfg?.label || owner.split(" ")[0]}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content */}
      {appointments.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <Calendar className="w-14 h-14 text-slate-200 mx-auto mb-3" />
            <p className="text-base font-bold text-slate-500">No appointments</p>
            <p className="text-sm text-slate-400 mt-1">
              {dateFilter === "today" ? "No meetings scheduled for today" :
               dateFilter === "tomorrow" ? "No meetings scheduled for tomorrow" :
               "No meetings in the next 7 days"}
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* Map panel — shown when map view is active */}
          {view === "map" && (
            <MapPageErrorBoundary>
              <MobileMapContainer
                appointments={appointments}
                selectedLead={selectedLead}
                onSelectLead={setSelectedLead}
                contactOwners={contactOwners}
                userRole={userRole}
              />
            </MapPageErrorBoundary>
          )}

          {/* Appointment cards — always shown below the map (or alone in list view) */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-24">
            {groupedByDate ? (
              Object.entries(groupedByDate)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, appts]) => (
                  <div key={date}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                        {formatDateLabel(date)}
                      </div>
                      <div className="flex-1 h-px bg-slate-200" />
                      <span className="text-xs font-semibold text-slate-400">{appts.length} appt{appts.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="space-y-3">
                      {appts.map((appt, idx) => (
                        <AppointmentCard
                          key={appt.id}
                          appt={appt}
                          idx={idx}
                          isSelected={selectedLead === appt.id}
                          onSelect={setSelectedLead}
                          ownerColor={appt.colorConfig}
                        />
                      ))}
                    </div>
                  </div>
                ))
            ) : (
              appointments.map((appt, idx) => (
                <AppointmentCard
                  key={appt.id}
                  appt={appt}
                  idx={idx}
                  isSelected={selectedLead === appt.id}
                  onSelect={setSelectedLead}
                  ownerColor={appt.colorConfig}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}