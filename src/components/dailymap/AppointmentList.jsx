import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Clock, MapPin, ExternalLink, AlertTriangle, Navigation,
  Flag, ArrowRight, Car, Timer, Home
} from "lucide-react";
import { fmt12 } from "@/pages/DailyMap";
import { formatPhone, toTitleCase } from "@/lib/formatters";
import { OWNER_COLORS } from "@/pages/DailyMap";

export default function AppointmentList({ appointments, selectedLead, onSelectLead, onReassign, contactOwners, userRole }) {
  const [reassigning, setReassigning] = useState(null);

  const handleReassign = async (leadId, newOwner) => {
    setReassigning(leadId);
    await onReassign(leadId, newOwner);
    setReassigning(null);
  };

  // Check if routing data is available (required departure times)
  const hasRouting = appointments.some(a => a.requiredDeparture);

  return (
    <div className="divide-y divide-slate-100">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">
          {appointments.length} Appointment{appointments.length !== 1 ? "s" : ""} — Sorted by Time
        </p>
        {hasRouting && (
          <p className="text-[10px] text-amber-600 font-semibold mt-0.5">
            🚗 Traffic-aware routing · Arrive 10 min before each appointment
          </p>
        )}
      </div>

      {appointments.map((appt, idx) => {
        const prev = idx > 0 ? appointments[idx - 1] : null;
        const isSelected = selectedLead === appt.id;
        const colorCfg = appt.colorConfig || OWNER_COLORS[appt.assigned_rep] || OWNER_COLORS["Unassigned"];
        const hasRoute = !!appt.requiredDeparture;
        const hasConflict = !!appt.conflict;

        return (
          <div key={appt.id}>
            {/* Routing segment: origin → destination */}
            {hasRoute && (
              <div className={`px-4 py-2 border-b ${hasConflict ? 'bg-red-50 border-red-100' : 'bg-blue-50 border-blue-100'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Home className="w-3 h-3 text-slate-400 flex-shrink-0" />
                  <span className="text-[10px] text-slate-500 font-semibold truncate">
                    From: {appt.originName || 'Starting location'}
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-5">
                  <div className="w-px h-3 bg-slate-300" />
                </div>
                <div className="flex items-center gap-2">
                  <Flag className="w-3 h-3 text-amber-500 flex-shrink-0" />
                  <span className="text-[10px] text-slate-600 font-semibold truncate">
                    To: {toTitleCase(appt.first_name)} {toTitleCase(appt.last_name)}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1.5 ml-5">
                  <span className="text-[10px] text-slate-500 flex items-center gap-1">
                    <Car className="w-3 h-3" /> {appt.driveDuration}
                  </span>
                  <span className="text-[10px] text-slate-500 flex items-center gap-1">
                    <Navigation className="w-3 h-3" /> {appt.driveDistance}
                  </span>
                </div>
              </div>
            )}

            {/* Schedule conflict warning */}
            {hasConflict && (
              <div className="px-4 py-2 bg-red-50 border-b border-red-100">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-bold text-red-700 uppercase tracking-wide">⚠ Schedule Conflict</p>
                    <p className="text-[10px] text-red-600 mt-0.5">
                      Must leave by {appt.conflict.requiredDeparture} but previous appointment ends at {appt.conflict.prevEndsAt}
                    </p>
                    <p className="text-[10px] text-red-500 mt-0.5">Cannot arrive 10 minutes early</p>
                  </div>
                </div>
              </div>
            )}

            {/* Main appointment card */}
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

              {/* Row 2: Routing details (departure, arrival, drive) */}
              {hasRoute && (
                <div className="ml-8.5 mb-2 bg-slate-50 rounded-lg px-2.5 py-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase">Leave by</span>
                    <span className="text-sm font-bold text-amber-600">{fmt12(appt.requiredDeparture)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase">Arrive by</span>
                    <span className="text-xs font-semibold text-emerald-600">{fmt12(appt.targetArrival)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span className="flex items-center gap-1"><Car className="w-2.5 h-2.5" /> {appt.driveDuration}</span>
                    <span className="flex items-center gap-1"><Navigation className="w-2.5 h-2.5" /> {appt.driveDistance}</span>
                  </div>
                </div>
              )}

              {/* Row 3: Address + Project */}
              <div className="ml-8.5 space-y-0.5">
                <div className="flex items-start gap-1.5">
                  {appt.geocodeError ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
                  )}
                  <span className={`text-xs ${appt.geocodeError ? "text-amber-600 font-semibold" : "text-slate-600"}`}>
                    {appt.geocodeError ? "⚠ Address needs review — " : ""}{appt.normalizedAddress || appt.fullAddress}
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
                        href={`https://www.google.com/maps/search/?api=1&query=${appt.coords.lat},${appt.coords.lng}`}
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