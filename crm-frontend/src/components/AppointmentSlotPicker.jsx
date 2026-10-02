/**
 * AppointmentSlotPicker
 *
 * Shows Yaron's calendar availability for a given date as a visual day schedule.
 * Busy slots are labeled "Busy" (no private event details exposed).
 * Available slots are selectable. The selected slot is highlighted.
 *
 * Uses the canonical backend availability engine (lib/booking/availabilityService.js,
 * via GET /api/v1/availability/:owner/:date) — the SAME engine the booking
 * write path checks against. Does NOT invent a second availability algorithm.
 *
 * Timezone: America/Los_Angeles (handled server-side). Appointment duration +
 * travel buffer: 1hr meeting + 1hr before/after — same rule the backend
 * write-path conflict check enforces.
 *
 * One single calendar is always shown regardless of the selected rep, per
 * requirement: "Yaron's calendar is the availability calendar that must be
 * shown" (EC's own case — Yaron is EC's default_owner_email). PRODUCTIZATION
 * PHASE 2: which calendar that is comes from this installation's configured
 * company_settings.default_owner_email, not a hardcoded EC address — a
 * fresh installation's own default owner is shown instead.
 */
import { useState, useEffect, useCallback } from 'react';
import { Clock, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { getBlockedSlots } from '@/api/railway/availability';
import * as railwayCompanySettings from '@/api/railway/companySettings';

// Fallback only if this installation hasn't configured a default owner yet.
const FALLBACK_OWNER_EMAIL = 'yaron@ecconstructiongroup.com';
const FALLBACK_OWNER_NAME = 'Yaron';

// Default 30-minute slots from 8:30 AM to 6:30 PM (matches the backend's
// product-default SLOTS). PRODUCTIZATION PHASE 2: the backend's availability
// response now carries the installation's actual configured grid (`slots` —
// company_settings.business_hours) — used when present, so a company with
// different business hours sees its own grid instead of this EC default.
const DEFAULT_SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue; // skip 8:00 (before business hours)
    if (h === 18 && m > 30) continue; // skip after 6:30 PM
    DEFAULT_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

function fmt12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export default function AppointmentSlotPicker({ date, selectedTime, onSelectTime }) {
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ownerEmail, setOwnerEmail] = useState(FALLBACK_OWNER_EMAIL);
  const [ownerName, setOwnerName] = useState(FALLBACK_OWNER_NAME);

  useEffect(() => {
    let cancelled = false;
    railwayCompanySettings.get()
      .then((cfg) => {
        if (cancelled) return;
        if (cfg?.default_owner_email) setOwnerEmail(cfg.default_owner_email);
        if (cfg?.default_owner_name) setOwnerName(cfg.default_owner_name.split(/\s+/)[0]);
      })
      .catch(() => { /* keep FALLBACK_OWNER_EMAIL / FALLBACK_OWNER_NAME */ });
    return () => { cancelled = true; };
  }, []);

  const loadAvailability = useCallback(async (d) => {
    if (!d) {
      setBlockedSlots([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getBlockedSlots({ ownerEmail, date: d });
      setBlockedSlots(data.blocked_slots || []);
      setSlots(Array.isArray(data.slots) && data.slots.length ? data.slots : DEFAULT_SLOTS);
    } catch (e) {
      setError(e.message || 'Failed to load availability');
      setBlockedSlots([]);
    } finally {
      setLoading(false);
    }
  }, [ownerEmail]);

  useEffect(() => {
    loadAvailability(date);
  }, [date, loadAvailability]);

  // Group slots into morning and afternoon for visual clarity
  const morningSlots = slots.filter(s => parseInt(s.split(':')[0]) < 12);
  const afternoonSlots = slots.filter(s => parseInt(s.split(':')[0]) >= 12);

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
        Select a date to view {ownerName}'s availability
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-6">
        <Loader2 className="w-5 h-5 text-amber-500 animate-spin mx-auto mb-2" />
        <p className="text-xs text-slate-500">Loading {ownerName}'s availability for {date}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-6">
        <AlertCircle className="w-5 h-5 text-red-400 mx-auto mb-2" />
        <p className="text-xs text-red-600 mb-2">{error}</p>
        <button
          onClick={() => loadAvailability(date)}
          className="text-xs font-semibold text-amber-600 hover:text-amber-700 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const availableCount = slots.length - blockedSlots.length;

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
        <span className="font-semibold text-slate-600">{ownerName}'s Schedule</span>
        <span>{availableCount} of {slots.length} slots available</span>
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