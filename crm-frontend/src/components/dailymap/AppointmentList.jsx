import { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, MapPin, User, Phone, ExternalLink, AlertTriangle, Navigation } from "lucide-react";
import { fmt12 } from "@/pages/DailyMap";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import { OWNER_COLORS } from "@/pages/DailyMap";

function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}

function kmToMiles(km) { return (km * 0.621371).toFixed(1); }
function estimateDrive(km) {
  if (!km) return null;
  const mins = Math.round((km / 50) * 60); // ~50 km/h avg
  if (mins < 60) return `~${mins} min`;
  return `~${Math.floor(mins/60)}h ${mins%60}m`;
}

export default function AppointmentList({ appointments, selectedLead, onSelectLead, onReassign, contactOwners, userRole }) {
  const [reassigning, setReassigning] = useState(null);

  const handleReassign = async (leadId, newOwner) => {
    setReassigning(leadId);
    await onReassign(leadId, newOwner);
    setReassigning(null);
  };

  return (
    <div className="divide-y divide-slate-100">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">
          {appointments.length} Appointment{appointments.length !== 1 ? "s" : ""} — Sorted by Time
        </p>
      </div>

      {appointments.map((appt, idx) => {
        const prev = idx > 0 ? appointments[idx - 1] : null;
        const distKm = prev?.coords && appt.coords ? haversineKm(prev.coords, appt.coords) : null;
        const isSelected = selectedLead === appt.id;
        const colorCfg = appt.colorConfig;

        return (
          <div key={appt.id}>
            {/* Distance from previous */}
            {distKm !== null && (
              <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-50 border-b border-blue-100">
                <Navigation className="w-3 h-3 text-blue-400 flex-shrink-0" />
                <span className="text-xs text-blue-600 font-semibold">
                  {kmToMiles(distKm)} mi from previous · {estimateDrive(distKm)}
                </span>
              </div>
            )}

            <div
              className={`px-4 py-3 cursor-pointer transition-colors ${isSelected ? "bg-amber-50 border-l-4 border-amber-500" : "hover:bg-slate-50"}`}
              onClick={() => onSelectLead(isSelected ? null : appt.id)}
            >
              {/* Row 1: Number + Name + Time */}
              <div className="flex items-start gap-2.5 mb-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
                  style={{ background: colorCfg.bg }}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      {toTitleCase(appt.first_name)} {toTitleCase(appt.last_name)}
                    </p>
                    <span className="text-xs font-semibold text-slate-600 flex items-center gap-1 flex-shrink-0">
                      <Clock className="w-3 h-3" /> {fmt12(appt.follow_up_time)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <div className="w-2 h-2 rounded-full" style={{ background: colorCfg.bg }} />
                    <span className="text-xs text-slate-500">{appt.assigned_rep || "Unassigned"}</span>
                  </div>
                </div>
              </div>

              {/* Row 2: Address + Project */}
              <div className="ml-8.5 space-y-0.5">
                <div className="flex items-start gap-1.5">
                  {appt.geocodeError ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
                  )}
                  <span className={`text-xs ${appt.geocodeError ? "text-amber-600 font-semibold" : "text-slate-600"}`}>
                    {appt.geocodeError ? "⚠ Address needs review — " : ""}{appt.fullAddress}
                  </span>
                </div>
                {appt.project_type && (
                  <p className="text-xs text-slate-500 ml-5">{appt.project_type}</p>
                )}
                {appt.phone && (
                  <p className="text-xs text-slate-500 ml-5">{formatPhone(appt.phone)}</p>
                )}
              </div>

              {/* Expanded: Reassign + Actions */}
              {isSelected && (
                <div className="ml-8.5 mt-3 space-y-2 border-t border-slate-100 pt-2">
                  {userRole === "admin" && (
                    <div>
                      <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Reassign</p>
                      <select
                        value={appt.assigned_rep || ""}
                        onChange={e => handleReassign(appt.id, e.target.value)}
                        disabled={reassigning === appt.id}
                        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500"
                      >
                        <option value="">— Unassigned —</option>
                        {contactOwners.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Link
                      to={`/leads/${appt.id}`}
                      className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-amber-600 text-white py-1.5 rounded-lg hover:bg-amber-700 transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      <ExternalLink className="w-3 h-3" /> Open Lead
                    </Link>
                    {appt.coords && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(appt.fullAddress)}`}
                        target="_blank" rel="noreferrer"
                        className="flex items-center justify-center gap-1 text-xs font-semibold text-blue-600 border border-blue-200 py-1.5 px-2.5 rounded-lg hover:bg-blue-50 transition-colors"
                        onClick={e => e.stopPropagation()}
                      >
                        <MapPin className="w-3 h-3" /> Directions
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}