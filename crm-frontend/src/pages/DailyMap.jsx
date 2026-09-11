import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/AuthContext";
import { routing as routingApi } from "@/api/railway";
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("split");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [projectTypeFilter, setProjectTypeFilter] = useState("all");
  const [selectedLead, setSelectedLead] = useState(null);
  const [contactOwners, setContactOwners] = useState([]);
  const [userRole, setUserRole] = useState(null);
  const [ownerConfig, setOwnerConfig] = useState({});

  const { user } = useAuth();

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const data = await routingApi.getDailySchedule({
        owner: ownerFilter,
        date: selectedDate,
        city: cityFilter,
        projectType: projectTypeFilter,
      });

      const appts = (data.appointments || []).map(a => ({
        ...a,
        colorConfig: OWNER_COLORS[a.assigned_rep] || OWNER_COLORS["Unassigned"],
        fullAddress: a.verifiedAddress || a.normalizedAddress || `${a.property_address || ''}, ${a.city || ''}, CA`,
      }));

      setAppointments(appts);
      setOwnerConfig(data.owner_config || {});

      // Build unique owners list from the full schedule (all owners)
      const owners = [...new Set(appts.map(a => a.assigned_rep).filter(Boolean))].sort();
      setContactOwners(owners);
    } catch (e) {
      console.error('[DailyMap] Failed to load schedule:', e);
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  }, [selectedDate, ownerFilter, cityFilter, projectTypeFilter]);

  useEffect(() => {
    if (user) {
      setUserRole(user.role);
      if (user.role === 'sales_rep') {
        const mappedOwner = USER_OWNER_MAP[user.email] || user.full_name;
        if (mappedOwner) setOwnerFilter(mappedOwner);
      }
    }
  }, [user]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  const handleReassign = async (leadId, newOwner) => {
    // Refresh schedule after reassignment
    await loadSchedule();
  };

  const openGoogleMapsRoute = () => {
    const withCoords = appointments.filter(a => a.coords);
    if (!withCoords.length) return;
    // Group by owner to build separate routes
    const byOwner = {};
    for (const a of withCoords) {
      const o = a.assigned_rep || 'Unassigned';
      if (!byOwner[o]) byOwner[o] = [];
      byOwner[o].push(a);
    }
    // For each owner, build a route from their starting location through their appointments
    for (const [owner, appts] of Object.entries(byOwner)) {
      appts.sort((a, b) => (a.follow_up_time || '23:59').localeCompare(b.follow_up_time || '23:59'));
      const startConfig = ownerConfig[owner];
      const waypoints = [];
      if (startConfig?.address) {
        waypoints.push(encodeURIComponent(startConfig.address));
      }
      for (const a of appts) {
        waypoints.push(encodeURIComponent(a.fullAddress));
      }
      window.open(`https://www.google.com/maps/dir/${waypoints.join('/')}`, '_blank');
      break; // Open one owner's route at a time
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <RefreshCw className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-slate-900">Daily Map</h1>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadSchedule}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button
            onClick={openGoogleMapsRoute}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Navigation className="w-3.5 h-3.5" /> Open Route
          </button>
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => setView("map")}
              className={`p-1.5 rounded-lg ${view === "map" ? "bg-slate-900 text-white" : "text-slate-400 hover:bg-slate-100"}`}
            >
              <MapIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView("list")}
              className={`p-1.5 rounded-lg ${view === "list" ? "bg-slate-900 text-white" : "text-slate-400 hover:bg-slate-100"}`}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView("split")}
              className={`p-1.5 rounded-lg ${view === "split" ? "bg-slate-900 text-white" : "text-slate-400 hover:bg-slate-100"}`}
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <MapFilters
        ownerFilter={ownerFilter} setOwnerFilter={userRole === 'sales_rep' ? () => {} : setOwnerFilter}
        cityFilter={cityFilter} setCityFilter={setCityFilter}
        projectTypeFilter={projectTypeFilter} setProjectTypeFilter={setProjectTypeFilter}
        owners={contactOwners}
        appointments={appointments}
      />

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {(view === "map" || view === "split") && (
          <div className={view === "split" ? "w-1/2 h-full" : "w-full h-full"}>
            <MapView
              appointments={appointments}
              selectedLead={selectedLead}
              onSelectLead={setSelectedLead}
            />
          </div>
        )}
        {(view === "list" || view === "split") && (
          <div className={view === "split" ? "w-1/2 h-full overflow-y-auto" : "w-full h-full overflow-y-auto"}>
            <AppointmentList
              appointments={appointments}
              selectedLead={selectedLead}
              onSelectLead={setSelectedLead}
              onReassign={handleReassign}
              userRole={userRole}
              ownerConfig={ownerConfig}
            />
          </div>
        )}
      </div>
    </div>
  );
}
