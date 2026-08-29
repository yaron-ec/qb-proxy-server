/**
 * AvailableTimePicker
 *
 * Loads the owner's Google Calendar availability for the selected date
 * and removes blocked slots from the dropdown entirely.
 *
 * Props:
 *   value      - currently selected time ("HH:MM")
 *   onChange   - called with "HH:MM" when user selects an available slot
 *   date       - "YYYY-MM-DD" — required to load availability
 *   ownerName  - assigned rep name
 *   disabled   - disables the whole picker
 *   className  - extra wrapper classes
 */
import { useState, useEffect, useRef } from "react";
import { getBlockedSlots } from "@/lib/calendarAvailability";
import { Loader2, AlertTriangle } from "lucide-react";

// Times from 8:30 AM to 6:30 PM
const ALL_SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue; // skip 8:00, start at 8:30
    if (h === 18 && m > 30) continue; // stop at 6:30 PM
    ALL_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

function fmt12(t) {
  if (!t) return t;
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export default function AvailableTimePicker({ value, onChange, date, ownerName, disabled, className = "", adminOverride = false }) {
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [quotaError, setQuotaError] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    // Cancel any in-flight request
    if (abortRef.current) abortRef.current = false;

    // Only load if BOTH date AND owner are selected
    if (!date || !ownerName) {
      setBlockedSlots([]);
      setLoading(false);
      setQuotaError(false);
      return;
    }

    let active = true;
    abortRef.current = true;

    setLoading(true);
    setLoadError(null);
    setQuotaError(false);

    getBlockedSlots(date, ownerName).then(data => {
      if (!active) return;
      const blocked = data?.blocked_slots || [];
      setBlockedSlots(blocked);
      if (!adminOverride && value && blocked.includes(value)) {
        onChange('');
      }
    }).catch(e => {
      if (!active) return;
      console.warn('[AvailableTimePicker] Could not check availability:', e.message);
      setBlockedSlots([]);
    }).finally(() => {
      if (!active) return;
      setLoading(false);
    });

    return () => { active = false; };
  }, [date, ownerName]); // Only fetch when date or owner changes

  // In admin override mode, show all slots; otherwise filter out blocked ones
  const visibleSlots = adminOverride ? ALL_SLOTS : ALL_SLOTS.filter(s => !blockedSlots.includes(s));
  const selectedIsBlocked = adminOverride && value && blockedSlots.includes(value);

  const handleChange = (e) => {
    const selected = e.target.value;
    if (!selected) { onChange(''); return; }
    onChange(selected);
  };

  return (
    <div className={className}>
      <div className="relative">
        <select
          value={value || ''}
          onChange={handleChange}
          disabled={disabled || loading || quotaError}
          className={`w-full border rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-colors ${selectedIsBlocked ? 'border-amber-400' : 'border-slate-200'} ${(disabled || loading || quotaError) ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <option value="">
            {loading ? 'Checking availability...' : quotaError ? 'Quota exceeded' : '— Select time'}
          </option>
          {visibleSlots.map(slot => {
            const isBlocked = adminOverride && blockedSlots.includes(slot);
            return (
              <option key={slot} value={slot}>
                {fmt12(slot)}{isBlocked ? ' ⚠ Already booked' : ''}
              </option>
            );
          })}
        </select>
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          </div>
        )}
      </div>

      {loadError && (
        <div className={`mt-1.5 flex items-start gap-1.5 rounded-lg px-2.5 py-2 border ${
          quotaError 
            ? 'bg-red-50 border-red-200' 
            : 'bg-amber-50 border-amber-200'
        }`}>
          <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
            quotaError 
              ? 'text-red-500' 
              : 'text-amber-500'
          }`} />
          <p className={`text-xs ${
            quotaError 
              ? 'text-red-700' 
              : 'text-amber-700'
          }`}>{loadError}{!quotaError && ' — showing all slots'}</p>
        </div>
      )}

      {!adminOverride && !loading && !loadError && date && ownerName && blockedSlots.length > 0 && (
        <p className="text-[10px] text-slate-400 mt-1">
          {blockedSlots.length} slot{blockedSlots.length !== 1 ? 's' : ''} removed — not available for {ownerName}
        </p>
      )}
      {adminOverride && selectedIsBlocked && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-lg px-2.5 py-2 border bg-amber-50 border-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
          <p className="text-xs text-amber-700 font-semibold">Admin override: this time slot is already booked. Both appointments will appear in the calendar.</p>
        </div>
      )}
    </div>
  );
}