/**
 * AppointmentSlotPicker
 *
 * Shows Yaron's calendar availability for a given date as a visual day schedule.
 * Busy slots are labeled "Busy" (no private event details exposed).
 * Available slots are selectable. The selected slot is highlighted.
 *
 * Uses the existing calendarAvailability.getBlockedSlots() — the same source of
 * truth used by the rest of the CRM (Google Calendar freeBusy + CRM meetings).
 * Does NOT invent a second availability algorithm.
 *
 * Timezone: America/Los_Angeles (handled by calendarAvailability.js).
 * Appointment duration + travel buffers: 120 min total window (1hr meeting + 1hr buffer)
 * — same rules as the existing CRM availability check.
 *
 * Yaron's calendar is always shown regardless of the selected rep, per requirement:
 * "Yaron's calendar is the availability calendar that must be shown."
 */
import { useState, useEffect, useCallback } from 'react';
import { Clock, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { getBlockedSlots } from '@/lib/calendarAvailability';

// Always use Yaron's calendar for availability, regardless of selected rep
const AVAILABILITY_OWNER = 'Yaron Drilevich';

// Generate 30-minute slots from 8:30 AM to 6:30 PM (matches calendarAvailability.js)
const SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue; // skip 8:00 (before business hours)
    if (h === 18 && m > 30) continue; // skip after 6:30 PM
    SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

function fmt12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export default function AppointmentSlotPicker({ date, selectedTime, onSelectTime }) {
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadAvailability = useCallback(async (d, forceRefresh = false) => {
    if (!d) {
      setBlockedSlots([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getBlockedSlots(d, AVAILABILITY_OWNER, { forceRefresh });
      setBlockedSlots(data.blocked_slots || []);
    } catch (e) {
      setError(e.message || 'Failed to load availability');
      setBlockedSlots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAvailability(date);
  }, [date, loadAvailability]);

  // Group slots into morning and afternoon for visual clarity
  const morningSlots = SLOTS.filter(s => parseInt(s.split(':')[0]) < 12);
  const afternoonSlots = SLOTS.filter(s => parseInt(s.split(':')[0]) >= 12);

  const renderSlot = (slot) => {
    const isBlocked = blockedSlots.includes(slot);
    const isSelected = selectedTime === slot;

    if (isBlocked) {
      return (
        <div
          key={slot}
          disabled
          className="px-2 py-2 text-[11px] font-semibold text-center rounded-lg bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
        >
          <div className="flex items-center justify-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {fmt12(slot)}
          </div>
          <span className="text-[9px] uppercase tracking-wide">Busy</span>
        </div>
      );
    }

    return (
      <button
        key={slot}
        type="button"
        onClick={() => onSelectTime(slot)}
        className={`px-2 py-2 text-[11px] font-semibold text-center rounded-lg border transition-all active:scale-95 ${
          isSelected
            ? 'bg-amber-600 text-white border-amber-600 shadow-sm ring-2 ring-amber-300'
            : 'bg-white text-slate-700 border-slate-200 hover:border-amber-400 hover:bg-amber-50'
        }`}
      >
        <div className="flex items-center justify-center gap-1">
          {isSelected && <CheckCircle2 className="w-2.5 h-2.5" />}
          {fmt12(slot)}
        </div>
        <span className={`text-[9px] uppercase tracking-wide ${isSelected ? 'text-amber-100' : 'text-emerald-600'}`}>
          {isSelected ? 'Selected' : 'Available'}
        </span>
      </button>
    );
  };

  if (!date) {
    return (
      <div className="text-center py-6 text-sm text-slate-400">
        <Clock className="w-6 h-6 text-slate-300 mx-auto mb-2" />
        Select a date to view Yaron's availability
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-6">
        <Loader2 className="w-5 h-5 text-amber-500 animate-spin mx-auto mb-2" />
        <p className="text-xs text-slate-500">Loading Yaron's availability for {date}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-6">
        <AlertCircle className="w-5 h-5 text-red-400 mx-auto mb-2" />
        <p className="text-xs text-red-600 mb-2">{error}</p>
        <button
          onClick={() => loadAvailability(date, true)}
          className="text-xs font-semibold text-amber-600 hover:text-amber-700 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const availableCount = SLOTS.length - blockedSlots.length;

  if (availableCount === 0) {
    return (
      <div className="text-center py-6">
        <AlertCircle className="w-5 h-5 text-amber-400 mx-auto mb-2" />
        <p className="text-xs text-slate-600 font-semibold mb-1">No available slots for {date}</p>
        <p className="text-[11px] text-slate-400">Please select a different date.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
        <span className="font-semibold text-slate-600">Yaron's Schedule</span>
        <span>{availableCount} of {SLOTS.length} slots available</span>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] text-slate-500 px-1">
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-white border border-slate-200"></div>
          <span>Available</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-slate-100 border border-slate-200"></div>
          <span>Busy</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-amber-600"></div>
          <span>Selected</span>
        </div>
      </div>

      {/* Morning slots */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 px-1">Morning</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {morningSlots.map(renderSlot)}
        </div>
      </div>

      {/* Afternoon slots */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 px-1">Afternoon</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {afternoonSlots.map(renderSlot)}
        </div>
      </div>
    </div>
  );
}