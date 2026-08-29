import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";
import { Link } from "react-router-dom";
import { MapPin, Clock, User, Phone, ExternalLink, Navigation, Filter, RefreshCw, AlertTriangle, List, Map as MapIcon, ChevronDown } from "lucide-react";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import MapView from "@/components/dailymap/MapView";
import AppointmentList from "@/components/dailymap/AppointmentList";
import MapFilters from "@/components/dailymap/MapFilters";

const USER_OWNER_MAP = {
  'yaron@ecconstructiongroup.com': 'Yaron Drilevich',
  'ethan@ecconstructiongroup.com': 'Ethan Magen',
  'micky@ecconstructiongroup.com': 'Micky Gad',
  'michelle@ecconstructiongroup.com': 'Michelle Ecenski',
  'matt@ecconstructiongroup.com': 'Matt',
  'karen@ecconstructiongroup.com': 'Karen',
};

const OWNER_COLORS = {
  "Yaron Drilevich": { bg: "#3B82F6", text: "white", label: "Yaron" },
  "Ethan Magen":     { bg: "#10B981", text: "white", label: "Ethan" },
  "Micky Gad":       { bg: "#F59E0B", text: "white", label: "Micky" },
  "Matt":            { bg: "#8B5CF6", text: "white", label: "Matt" },
  "Karen":           { bg: "#EC4899", text: "white", label: "Karen" },
  "Michelle Ecenski":{ bg: "#F97316", text: "white", label: "Michelle" },
  "Unassigned":      { bg: "#6B7280", text: "white", label: "Unassigned" },
};

export { OWNER_COLORS };

function getTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export { fmt12 };

async function geocodeAddress(address) {
  const query = encodeURIComponent(address);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`, {
    headers: { "Accept-Language": "en" }
  });
  const data = await res.json();
  if (data?.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

export { geocodeAddress };

export default function DailyMap() {
  const [selectedDate, setSelectedDate] = useState(getTodayLocal());
  const [allLeads, setAllLeads] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const [view, setView] = useState("split"); // "map" | "list" | "split"
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [projectTypeFilter, setProjectTypeFilter] = useState("all");
  const [selectedLead, setSelectedLead] = useState(null);
  const [contactOwners, setContactOwners] = useState([]);
  const [userRole, setUserRole] = useState(null);

  const { user } = useAuth();

  useEffect(() => {
    if (user) {
      setUserRole(user.role);
      if (user.role === 'sales_rep') {
        const mappedOwner = USER_OWNER_MAP[user.email] || user.full_name;
        if (mappedOwner) setOwnerFilter(mappedOwner);
      }
    }
    // Railway API handles owner-scoping server-side (no RLS $in issue)
    railwayLeads.list({ limit: 2000 }).then(res => {
      setAllLeads(res.items || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!allLeads.length) return;
    buildAppointments();
  }, [selectedDate, allLeads, ownerFilter, cityFilter, projectTypeFilter]);

  const buildAppointments = async () => {
    const excluded = ["Lost", "DNQ", "Cancelled", "Closed Lost"];
    const filtered = allLeads.filter(l =>
      l.follow_up_type === "Meeting" &&
      l.follow_up_date === selectedDate &&
      !excluded.includes(l.status) &&
      (l.property_address || l.city)
    );

    // Apply filters
    const ownerFiltered = ownerFilter === "all" ? filtered : filtered.filter(l =>
      ownerFilter === "Unassigned"
        ? !l.assigned_rep
        : l.assigned_rep === ownerFilter
    );
    const cityFiltered = cityFilter === "all" ? ownerFiltered : ownerFiltered.filter(l =>
      (l.city || "").toLowerCase() === cityFilter.toLowerCase()
    );
    const typeFiltered = projectTypeFilter === "all" ? cityFiltered : cityFiltered.filter(l =>
      (l.project_type || "").toLowerCase().includes(projectTypeFilter.toLowerCase())
    );

    // Sort by time
    const sorted = [...typeFiltered].sort((a, b) => {
      const ta = a.follow_up_time || "23:59";
      const tb = b.follow_up_time || "23:59";
      return ta.localeCompare(tb);
    });

    // Build unique owners list
    const owners = [...new Set(allLeads.filter(l => l.assigned_rep).map(l => l.assigned_rep))].sort();
    setContactOwners(owners);

    // Geocode addresses
    setGeocoding(true);
    const geocoded = await Promise.all(sorted.map(async (lead) => {
      const addrParts = [lead.property_address, lead.city, "CA"].filter(Boolean);
      const fullAddr = addrParts.join(", ");
      let coords = null;
      let geocodeError = false;
      try {
        coords = await geocodeAddress(fullAddr);
        if (!coords) geocodeError = true;
      } catch {
        geocodeError = true;
      }
      const ownerKey = lead.assigned_rep || "Unassigned";
      const colorConfig = OWNER_COLORS[ownerKey] || OWNER_COLORS["Unassigned"];
      return { ...lead, coords, geocodeError, colorConfig, fullAddress: fullAddr };
    }));
    setGeocoding(false);
    setAppointments(geocoded);
  };

  const handleReassign = async (leadId, newOwner) => {
    await railwayLeads.update(leadId, { assigned_rep: newOwner });
    setAllLeads(prev => prev.map(l => l.id === leadId ? { ...l, assigned_rep: newOwner } : l));
  };

  const openGoogleMapsRoute = () => {
    const withCoords = appointments.filter(a => a.coords);
    if (!withCoords.length) return;
    const waypoints = withCoords.map(a => encodeURIComponent(a.fullAddress)).join("/");
    window.open(`https://www.google.com/maps/dir/${waypoints}`, "_blank");
  };

  // Unique cities for filter
  const cities = [...new Set(allLeads.filter(l => l.city).map(l => l.city))].sort();
  const projectTypes = [...new Set(allLeads.filter(l => l.project_type).map(l => l.project_type))].sort();

  const geocodedCount = appointments.filter(a => a.coords).length;
  const errorCount = appointments.filter(a => a.geocodeError).length;

  return (
    <div className="flex flex-col bg-slate-50" style={{ height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <MapPin className="w-5 h-5 text-amber-600" />
              Daily Appointment Map
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {appointments.length} appointment{appointments.length !== 1 ? "s" : ""} · {geocodedCount} mapped
              {errorCount > 0 && <span className="text-amber-600 ml-2">· {errorCount} need address review</span>}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Date picker */}
            <input
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 bg-white focus:outline-none focus:border-amber-500"
            />

            {/* View toggle */}
            <div className="flex border border-slate-200 rounded-lg overflow-hidden">
              {[
                { id: "map", icon: MapIcon, label: "Map" },
                { id: "split", icon: List, label: "Split" },
                { id: "list", icon: List, label: "List" },
              ].map(v => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={`px-3 py-2 text-xs font-semibold transition-colors ${
                    view === v.id ? "bg-amber-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {/* Open in Google Maps */}
            {appointments.filter(a => a.coords).length > 0 && (
              <button
                onClick={openGoogleMapsRoute}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Navigation className="w-3.5 h-3.5" /> Open Route
              </button>
            )}

            {geocoding && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Mapping...
              </div>
            )}
          </div>
        </div>

        {/* Filters — owner filter hidden/locked for sales_rep */}
        <MapFilters
          ownerFilter={ownerFilter} setOwnerFilter={userRole === 'sales_rep' ? () => {} : setOwnerFilter}
          cityFilter={cityFilter} setCityFilter={setCityFilter}
          projectTypeFilter={projectTypeFilter} setProjectTypeFilter={setProjectTypeFilter}
          owners={userRole === 'sales_rep' ? [] : contactOwners}
          cities={cities} projectTypes={projectTypes}
          hideOwnerFilter={userRole === 'sales_rep'}
        />
      </div>

      {/* Owner legend */}
      <div className="bg-white border-b border-slate-100 px-6 py-2 flex items-center gap-3 flex-wrap flex-shrink-0">
        {Object.entries(OWNER_COLORS).map(([name, cfg]) => (
          <div key={name} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full" style={{ background: cfg.bg }} />
            <span className="text-xs text-slate-600">{cfg.label}</span>
          </div>
        ))}
      </div>

      {/* Main content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-500">Loading appointments...</p>
          </div>
        </div>
      ) : appointments.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <MapPin className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-base font-semibold text-slate-600">No appointments on this day</p>
            <p className="text-sm text-slate-400 mt-1">Select a different date or check filters</p>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
          {/* Map */}
          {(view === "map" || view === "split") && (
            <div style={{ position: "relative", flex: view === "split" ? 1 : undefined, width: view === "map" ? "100%" : undefined, minHeight: 0 }}>
              <MapView
                appointments={appointments}
                selectedLead={selectedLead}
                onSelectLead={setSelectedLead}
                onReassign={handleReassign}
                contactOwners={contactOwners}
                userRole={userRole}
              />
            </div>
          )}

          {/* List */}
          {(view === "list" || view === "split") && (
            <div style={{ width: view === "split" ? "24rem" : "100%", flexShrink: 0, overflowY: "auto", background: "white", borderLeft: view === "split" ? "1px solid #e2e8f0" : undefined }}>
              <AppointmentList
                appointments={appointments}
                selectedLead={selectedLead}
                onSelectLead={setSelectedLead}
                onReassign={handleReassign}
                contactOwners={contactOwners}
                userRole={userRole}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}