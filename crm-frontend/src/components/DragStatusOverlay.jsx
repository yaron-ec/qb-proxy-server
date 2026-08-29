/**
 * DragStatusOverlay
 *
 * Renders a fixed full-screen overlay with status drop zones.
 * Called by the drag hook when a drag is in progress.
 */
import { useRef } from "react";

const STATUSES = [
  { id: "New",                          label: "New",                  color: "#64748b", bg: "#f8fafc", border: "#cbd5e1" },
  { id: "No answer",                    label: "No Answer",            color: "#94a3b8", bg: "#f1f5f9", border: "#cbd5e1" },
  { id: "Answered, no appointment set", label: "Answered",             color: "#d97706", bg: "#fffbeb", border: "#fcd34d" },
  { id: "Appointment scheduled",        label: "Appt Scheduled",       color: "#2563eb", bg: "#eff6ff", border: "#93c5fd" },
  { id: "No show",                      label: "No Show",              color: "#f97316", bg: "#fff7ed", border: "#fdba74" },
  { id: "Proposal Sent",                label: "Proposal Sent",        color: "#7c3aed", bg: "#f5f3ff", border: "#c4b5fd" },
  { id: "Sold",                         label: "Sold ✓",               color: "#16a34a", bg: "#f0fdf4", border: "#86efac" },
  { id: "Lost",                         label: "Lost",                 color: "#dc2626", bg: "#fef2f2", border: "#fca5a5" },
  { id: "DNQ",                          label: "DNQ",                  color: "#ea580c", bg: "#fff7ed", border: "#fdba74" },
];

export { STATUSES };

export default function DragStatusOverlay({ hoveredStatus, onStatusHover, ghostPos, lead }) {
  if (!lead) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ background: "rgba(15,23,42,0.55)", backdropFilter: "blur(2px)" }}
    >
      {/* Ghost card following cursor */}
      {ghostPos && (
        <div
          className="fixed pointer-events-none z-[9999] select-none"
          style={{ left: ghostPos.x + 14, top: ghostPos.y - 20, width: 220 }}
        >
          <div className="bg-white rounded-lg border-2 border-amber-400 shadow-2xl px-4 py-3 opacity-90 rotate-2">
            <p className="text-xs font-bold text-slate-900 truncate">
              {lead.first_name} {lead.last_name}
            </p>
            {lead.project_type && (
              <p className="text-[10px] text-slate-500 truncate mt-0.5">{lead.project_type}</p>
            )}
            <p className="text-[10px] text-amber-600 font-semibold mt-1">Drag to a status →</p>
          </div>
        </div>
      )}

      {/* Status drop panel */}
      <div className="relative z-[9999] bg-white rounded-2xl shadow-2xl p-5 mx-4 select-none"
        style={{ maxWidth: 560, width: "100%" }}>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 text-center">
          Drop on a status to update
        </p>
        <div className="grid grid-cols-3 gap-2.5">
          {STATUSES.map(s => {
            const isHovered = hoveredStatus === s.id;
            const isCurrent = lead.status === s.id;
            return (
              <div
                key={s.id}
                data-status-zone={s.id}
                onMouseEnter={() => onStatusHover(s.id)}
                onMouseLeave={() => onStatusHover(null)}
                className="rounded-xl border-2 flex flex-col items-center justify-center py-3 px-2 transition-all duration-100 cursor-pointer"
                style={{
                  background: isHovered ? s.color : s.bg,
                  borderColor: isHovered ? s.color : (isCurrent ? s.color : s.border),
                  boxShadow: isHovered ? `0 0 0 3px ${s.color}44` : "none",
                  transform: isHovered ? "scale(1.05)" : "scale(1)",
                }}
              >
                <span
                  className="text-xs font-bold text-center leading-snug"
                  style={{ color: isHovered ? "#fff" : s.color }}
                >
                  {s.label}
                </span>
                {isCurrent && !isHovered && (
                  <span className="text-[9px] font-semibold mt-1 opacity-60" style={{ color: s.color }}>current</span>
                )}
                {isHovered && (
                  <span className="text-[10px] text-white font-bold mt-1 opacity-80">↓ drop here</span>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-center text-xs text-slate-400 mt-4">Release outside to cancel</p>
      </div>
    </div>
  );
}