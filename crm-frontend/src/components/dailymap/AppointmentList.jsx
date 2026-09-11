import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Clock, MapPin, ExternalLink, AlertTriangle, Navigation,
  Car, ChevronDown
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

  const hasRouting = appointments.some(a => a.requiredDeparture);

  return (
    <div className="divide-y divide-slate-100">
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
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
        const isSelected = selectedLead === appt.id;
        const colorCfg = appt.colorConfig || OWNER_COLORS[appt.assigned_rep] || OWNER_COLORS["Unassigned"];
        const hasRoute = !!appt.requiredDeparture;
        const hasConflict = !!appt.conflict;
        const hasNoStart = !!appt.hasNoStartConfig;

        return (
          <div key={appt.id}
            className={`px-4 py-2 cursor-pointer transition-colors ${isSelected ? "bg-amber-50 border-l-4 border-amber-500" : "hover:bg-slate-50"}`}
            onClick={() => onSelectLead(isSelected ? null : appt.id)}
          >
            {/* Row 1: Number + Name + Time */}
            <div className="flex items-center gap-2.5">
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                style={{ background: colorCfg.bg }}>
                {idx + 1}
              </div>
              <p className="text-sm font-bold text-slate-900 truncate flex-1">
                {toTitleCase(appt.first_name)} {toTitleCase(appt.last_name)}
              </p>
              <span className="text-xs font-semibold text-slate-700 flex items-center gap-1 flex-shrink-0">
                <Clock className="w-3 h-3" /> {fmt12(appt.follow_up_time)}
              </span>
            </div>

            {/* Row 2: Owner + Address + Project */}
            <div className="ml-7.5 mt-1 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: colorCfg.bg }} />
                <span className="text-[11px] text-slate-500">{appt.assigned_rep || "Unassigned"}</span>
                {appt.project_type && (
                  <span className="text-[11px] text-slate-400">· {appt.project_type}</span>
                )}
              </div>
              <div className="flex items-start gap-1">
                {appt.geocodeError ? (
                  <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <MapPin className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" />
                )}
                <span className={`text-[11px] leading-tight ${appt.geocodeError ? "text-amber-600 font-semibold" : "text-slate-600"}`}>
                  {appt.geocodeError ? "⚠ Address needs review — " : ""}{appt.verifiedAddress || appt.normalizedAddress || appt.fullAddress}
                </span>
              </div>
            </div>

            {/* Row 3: Inline routing */}
            {hasRoute && (
              <div className="ml-7.5 mt-1.5 flex items-center gap-2 flex-wrap text-[11px]">
                <span className="font-semibold text-slate-500">🚗</span>
                <span className="font-semibold text-amber-600">Leave {fmt12(appt.requiredDeparture)}</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-600 flex items-center gap-0.5"><Car className="w-3 h-3" /> {appt.driveDuration}</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-600 flex items-center gap-0.5"><Navigation className="w-3 h-3" /> {appt.driveDistance}</span>
                <span className="text-slate-400">·</span>
                <span className="font-semibold text-emerald-600">Arrive {fmt12(appt.targetArrival)}</span>
              </div>
            )}

            {/* No start config warning */}
            {hasNoStart && !hasRoute && (
              <div className="ml-7.5 mt-1.5 text-[11px] font-semibold text-amber-600 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Starting location required — Configuration Required
              </div>
            )}

            {/* Compact conflict warning */}
            {hasConflict && (
              <div className="ml-7.5 mt-1.5 text-[11px] text-red-600 font-semibold flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                <span>Schedule conflict — must leave {appt.conflict.requiredDeparture}, prev ends {appt.conflict.prevEndsAt}</span>
              </div>
            )}

            {/* Expanded: Reassign + Actions */}
            {isSelected && (
              <div className="ml-7.5 mt-2 space-y-2 border-t border-slate-100 pt-2">
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
        );
      })}
    </div>
  );
}