import { Clock, Loader2, AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";

/**
 * CaptureSlotGrid — visual appointment time picker for the Lead Capture form.
 *
 * Renders 30-minute slots (8:30 AM – 6:30 PM) as a responsive grid with three
 * visible states: Available (selectable), Blocked (disabled), Selected.
 *
 * Data source: the `blockedSlots` array passed in — produced by the existing
 * Railway availability endpoint (1hr-before + duration + 1hr-after buffer rule).
 * This component does NOT invent its own availability logic.
 *
 * Admin override (canOverride=true):
 *   Blocked slots remain visually BLOCKED but gain an explicit "Override"
 *   action. Selecting it fires onSelectTime(slot, { override:true }) so the
 *   parent can require a confirmation before submitting. A blocked slot that
 *   is the active override selection renders as amber with an "Override" label
 *   so the double-book is visually obvious. Normal users never see the action.
 *
 * Mobile-first: grid-cols-3 on phones, grid-cols-4 on sm+.
 */
const SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue; // start at 8:30
    if (h === 18 && m > 30) continue; // stop at 6:30 PM
    SLOTS.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
}

function fmt12(t) {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export default function CaptureSlotGrid({
  date, selectedTime, onSelectTime, blockedSlots, loading, error, onRetry,
  canOverride = false, overrideSelected = false,
}) {
  const morning = SLOTS.filter((s) => parseInt(s.split(":")[0], 10) < 12);
  const afternoon = SLOTS.filter((s) => parseInt(s.split(":")[0], 10) >= 12);

  if (!date) {
    return (
      <div className="text-center py-6 text-sm text-slate-400">
        <Clock className="w-6 h-6 text-slate-300 mx-auto mb-2" />
        Select a date to view availability
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-6">
        <Loader2 className="w-5 h-5 text-amber-500 animate-spin mx-auto mb-2" />
        <p className="text-xs text-slate-500">Checking availability…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-6">
        <AlertCircle className="w-5 h-5 text-red-400 mx-auto mb-2" />
        <p className="text-xs text-red-600 mb-2">{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="text-xs font-semibold text-amber-600 hover:text-amber-700 underline">
            Retry
          </button>
        )}
      </div>
    );
  }

  const renderSlot = (slot) => {
    const isBlocked = (blockedSlots || []).includes(slot);
    const isSelected = selectedTime === slot;
    const isOverrideActive = overrideSelected && isSelected && isBlocked;

    // Blocked slot — admins get an explicit override action; everyone else
    // sees a non-selectable disabled tile (unchanged behavior).
    if (isBlocked) {
      if (isOverrideActive) {
        return (
          <button
            key={slot}
            type="button"
            onClick={() => onSelectTime(slot, { override: true })}
            className="px-2 py-2 text-[11px] font-semibold text-center rounded-lg border-2 border-amber-600 bg-amber-600 text-white shadow-sm ring-2 ring-amber-300 transition-all active:scale-95"
          >
            <div className="flex items-center justify-center gap-1">
              <ShieldAlert className="w-2.5 h-2.5" />
              {fmt12(slot)}
            </div>
            <span className="text-[9px] uppercase tracking-wide text-amber-100">Override</span>
          </button>
        );
      }
      if (canOverride) {
        return (
          <button
            key={slot}
            type="button"
            onClick={() => onSelectTime(slot, { override: true })}
            className="px-2 py-2 text-[11px] font-semibold text-center rounded-lg bg-slate-100 text-slate-500 border border-slate-300 border-dashed hover:border-amber-400 hover:bg-amber-50 transition-all active:scale-95"
            title="Admin override — double-book this slot"
          >
            <div className="flex items-center justify-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {fmt12(slot)}
            </div>
            <span className="text-[9px] uppercase tracking-wide text-amber-600 font-bold">Blocked · Override</span>
          </button>
        );
      }
      return (
        <div
          key={slot}
          className="px-2 py-2 text-[11px] font-semibold text-center rounded-lg bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed select-none"
          aria-disabled="true"
        >
          <div className="flex items-center justify-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {fmt12(slot)}
          </div>
          <span className="text-[9px] uppercase tracking-wide">Blocked</span>
        </div>
      );
    }

    return (
      <button
        key={slot}
        type="button"
        onClick={() => onSelectTime(slot)}
        className={`px-2 py-2 text-[11px] font-semibold text-center rounded-lg border transition-all active:scale-95 ${
          isSelected && !overrideSelected
            ? "bg-amber-600 text-white border-amber-600 shadow-sm ring-2 ring-amber-300"
            : "bg-white text-slate-700 border-slate-200 hover:border-amber-400 hover:bg-amber-50"
        }`}
      >
        <div className="flex items-center justify-center gap-1">
          {isSelected && !overrideSelected && <CheckCircle2 className="w-2.5 h-2.5" />}
          {fmt12(slot)}
        </div>
        <span className={`text-[9px] uppercase tracking-wide ${isSelected && !overrideSelected ? "text-amber-100" : "text-emerald-600"}`}>
          {isSelected && !overrideSelected ? "Selected" : "Available"}
        </span>
      </button>
    );
  };

  const availableCount = SLOTS.length - (blockedSlots || []).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
        <span className="font-semibold text-slate-600">Yaron's Availability</span>
        <span>{availableCount} of {SLOTS.length} open</span>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-slate-500 px-1 flex-wrap">
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-white border border-slate-200" />
          <span>Available</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-slate-100 border border-slate-200" />
          <span>Blocked</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded bg-amber-600" />
          <span>Selected</span>
        </div>
        {canOverride && (
          <div className="flex items-center gap-1 text-amber-600 font-semibold">
            <ShieldAlert className="w-2.5 h-2.5" />
            <span>Override available</span>
          </div>
        )}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 px-1">Morning</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {morning.map(renderSlot)}
        </div>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 px-1">Afternoon</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {afternoon.map(renderSlot)}
        </div>
      </div>
    </div>
  );
}