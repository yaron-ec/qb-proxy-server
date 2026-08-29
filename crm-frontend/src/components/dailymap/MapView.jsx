import { useEffect, useState, useRef, Component } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { Link } from "react-router-dom";
import { Phone, ExternalLink, MessageSquare, Navigation, Clock, AlertTriangle, RefreshCw } from "lucide-react";
import { fmt12 } from "@/pages/DailyMap";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// ── Leaflet icon fix (safe — runs after bundle load, not at parse time) ──
let leafletFixed = false;
function ensureLeafletIcons() {
  if (leafletFixed) return;
  leafletFixed = true;
  try {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  } catch (e) {
    console.warn("[MapView] Leaflet icon fix failed:", e);
  }
}

// ── Leaflet z-index CSS (injected safely inside component) ──
const LEAFLET_CSS = `.leaflet-container { z-index: 0 !important; } .leaflet-pane { z-index: 400 !important; } .leaflet-top, .leaflet-bottom { z-index: 1000 !important; }`;
function InjectLeafletCSS() {
  useEffect(() => {
    if (document.getElementById("leaflet-zindex-fix")) return;
    const tag = document.createElement("style");
    tag.id = "leaflet-zindex-fix";
    tag.textContent = LEAFLET_CSS;
    document.head.appendChild(tag);
  }, []);
  return null;
}

function createColoredIcon(color, number) {
  try {
    const safeColor = color || "#6B7280";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
      <path d="M16 0C7.163 0 0 7.163 0 16c0 10 16 24 16 24s16-14 16-24C32 7.163 24.837 0 16 0z" fill="${safeColor}" stroke="white" stroke-width="2"/>
      <circle cx="16" cy="16" r="8" fill="white" opacity="0.9"/>
      <text x="16" y="20" text-anchor="middle" font-size="${number > 9 ? 8 : 10}" font-weight="bold" fill="${safeColor}" font-family="Arial">${number}</text>
    </svg>`;
    return L.divIcon({ html: svg, className: "", iconSize: [32, 40], iconAnchor: [16, 40], popupAnchor: [0, -40] });
  } catch (e) {
    console.warn("[MapView] createColoredIcon failed:", e);
    return new L.Icon.Default();
  }
}

function FitBounds({ appointments }) {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        map.invalidateSize();
        const valid = appointments.filter(a => a.coords?.lat && a.coords?.lng);
        if (valid.length === 0) return;
        if (valid.length === 1) {
          map.setView([valid[0].coords.lat, valid[0].coords.lng], 13);
          return;
        }
        const bounds = L.latLngBounds(valid.map(a => [a.coords.lat, a.coords.lng]));
        map.fitBounds(bounds, { padding: [40, 40] });
      } catch (e) {
        console.warn("[MapView] FitBounds error:", e);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [appointments]);
  return null;
}

function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    try { map.invalidateSize(); } catch {}
    const t = setTimeout(() => { try { map.invalidateSize(); } catch {} }, 400);
    return () => clearTimeout(t);
  }, []);
  return null;
}

// ── Error boundary — catches any Leaflet crash and shows a message ──
class MapErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[MapView] Caught render error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-amber-500" />
          <div>
            <p className="font-semibold text-slate-700">Map failed to load</p>
            <p className="text-xs text-slate-500 mt-1">{this.state.error?.message || "Unknown error"}</p>
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg"
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Inner map — rendered only when height is confirmed > 0 ──
function LeafletMap({ appointments, selectedLead, onSelectLead, onReassign, contactOwners, userRole, mapHeight }) {
  const [reassigning, setReassigning] = useState(null);

  const handleReassign = async (leadId, newOwner) => {
    setReassigning(leadId);
    await onReassign(leadId, newOwner);
    setReassigning(null);
  };

  // Only use appointments with valid numeric coords
  const validAppts = appointments.filter(a => {
    const lat = a.coords?.lat;
    const lng = a.coords?.lng;
    return typeof lat === "number" && typeof lng === "number" && !isNaN(lat) && !isNaN(lng);
  });

  const center = validAppts.length > 0
    ? [validAppts[0].coords.lat, validAppts[0].coords.lng]
    : [34.052235, -118.243683];

  // Stable key — only remount when the set of valid appointment IDs changes
  const mapKey = validAppts.map(a => a.id).join(",") || "empty-map";

  return (
    <MapContainer
      key={mapKey}
      center={center}
      zoom={10}
      style={{ height: mapHeight, width: "100%" }}
      className="z-0"
    >
      <InjectLeafletCSS />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <InvalidateOnMount />
      <FitBounds appointments={appointments} />

      {validAppts.map((appt, idx) => {
        const iconColor = appt.colorConfig?.bg || "#6B7280";
        const icon = createColoredIcon(iconColor, idx + 1);
        return (
          <Marker
            key={appt.id}
            position={[appt.coords.lat, appt.coords.lng]}
            icon={icon}
            eventHandlers={{ click: () => onSelectLead(appt.id === selectedLead ? null : appt.id) }}
          >
            <Popup maxWidth={280}>
              <div className="p-1 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                    style={{ background: iconColor }}>
                    {idx + 1}
                  </div>
                  <div>
                    <p className="font-bold text-slate-900 text-sm">{toTitleCase(appt.first_name)} {toTitleCase(appt.last_name)}</p>
                    <p className="text-xs text-slate-500 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {fmt12(appt.follow_up_time)}
                    </p>
                  </div>
                </div>

                <div className="space-y-1 text-xs text-slate-600 border-t pt-2">
                  <p><span className="font-semibold">Address:</span> {appt.fullAddress}</p>
                  {appt.project_type && <p><span className="font-semibold">Project:</span> {appt.project_type}</p>}
                  {appt.phone && <p><span className="font-semibold">Phone:</span> {formatPhone(appt.phone)}</p>}
                  <p><span className="font-semibold">Owner:</span> {appt.assigned_rep || "Unassigned"}</p>
                </div>

                {userRole === "admin" && (
                  <div className="border-t pt-2">
                    <p className="text-[10px] font-semibold text-slate-500 mb-1">REASSIGN TO</p>
                    <select
                      defaultValue={appt.assigned_rep || ""}
                      onChange={e => handleReassign(appt.id, e.target.value)}
                      disabled={reassigning === appt.id}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none"
                    >
                      <option value="">— Unassigned —</option>
                      {contactOwners.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <Link
                    to={`/leads/${appt.id}`}
                    className="flex items-center justify-center gap-1 text-xs font-semibold bg-amber-600 text-white px-2 py-2 rounded col-span-2"
                  >
                    <ExternalLink className="w-3 h-3" /> Open Lead
                  </Link>
                  {appt.phone && (
                    <a href={`tel:${appt.phone}`}
                      className="flex items-center justify-center gap-1 text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-2 rounded">
                      <Phone className="w-3 h-3" /> Call
                    </a>
                  )}
                  {appt.phone && (
                    <a href={`sms:${appt.phone}`}
                      className="flex items-center justify-center gap-1 text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-2 py-2 rounded">
                      <MessageSquare className="w-3 h-3" /> SMS
                    </a>
                  )}
                  {appt.fullAddress && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(appt.fullAddress)}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center justify-center gap-1 text-xs font-semibold bg-slate-50 text-slate-700 border border-slate-200 px-2 py-2 rounded col-span-2"
                    >
                      <Navigation className="w-3 h-3" /> Navigate
                    </a>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

// ── Public export — handles height measurement + error boundary ──
export default function MapView({ appointments, selectedLead, onSelectLead, onReassign, contactOwners, userRole, explicitHeight }) {
  // Call icon fix safely here (not at module parse time)
  useEffect(() => { ensureLeafletIcons(); }, []);

  // If an explicit pixel height was passed (from MobileMapContainer), use it directly.
  // Otherwise fall back to 100% (desktop split view where parent has real height).
  const mapHeight = explicitHeight ? `${explicitHeight}px` : "100%";

  // Don't render if height is explicitly 0 — Leaflet will throw
  if (explicitHeight !== undefined && explicitHeight <= 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="w-6 h-6 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: mapHeight, overflow: "hidden" }}>
      <MapErrorBoundary>
        <LeafletMap
          appointments={appointments}
          selectedLead={selectedLead}
          onSelectLead={onSelectLead}
          onReassign={onReassign}
          contactOwners={contactOwners}
          userRole={userRole}
          mapHeight={mapHeight}
        />
      </MapErrorBoundary>
    </div>
  );
}