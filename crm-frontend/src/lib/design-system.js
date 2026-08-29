/**
 * EC Construction Group — Unified Design System
 * Use these tokens and helpers everywhere for consistent styling.
 */

// ── Status badge styles — COLOR ONLY (used by statusBadgeClass) ──────────────
export const STATUS_STYLES = {
  "New":                          "bg-blue-50 text-blue-700 border border-blue-200",
  "Appointment scheduled":        "bg-emerald-100 text-emerald-800 border border-emerald-300",
  "Answered, no appointment set": "bg-amber-50 text-amber-700 border border-amber-200",
  "No answer":                    "bg-slate-100 text-slate-600 border border-slate-200",
  "Proposal Sent":                "bg-violet-50 text-violet-700 border border-violet-200",
  "No show":                      "bg-red-50 text-red-600 border border-red-200",
  "DNQ":                          "bg-slate-100 text-slate-500 border border-slate-200",
  "Sold":                         "bg-emerald-600 text-white border border-emerald-700",
  "Lost":                         "bg-red-50 text-red-700 border border-red-200",
};

// Canonical casing for status values
const STATUS_CANONICAL = Object.fromEntries(
  Object.keys(STATUS_STYLES).map(k => [k.toLowerCase(), k])
);

/**
 * Returns ONLY the color classes for a status (background + text + border).
 * Use statusBadgeClass() when you want the full badge including sizing.
 */
export function getStatusStyle(status) {
  if (!status) return "bg-slate-100 text-slate-500 border border-slate-200";
  const canonical = STATUS_CANONICAL[status.toLowerCase()];
  return STATUS_STYLES[canonical] || "bg-slate-100 text-slate-500 border border-slate-200";
}

/**
 * CANONICAL BADGE — use this everywhere a status badge is rendered.
 * Produces a compact pill — 20% smaller than default for a premium feel.
 * Usage:  <span className={statusBadgeClass(lead.status)}>{lead.status}</span>
 */
export function statusBadgeClass(status) {
  return `inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${getStatusStyle(status)}`;
}

// ── Page-level layout wrappers ───────────────────────────────────────────────
export const PAGE_WRAPPER   = "min-h-screen bg-slate-50";
export const PAGE_PADDING   = "px-6 py-6 max-w-7xl mx-auto";
export const SECTION_GAP    = "space-y-6";

// ── Card styles ──────────────────────────────────────────────────────────────
export const CARD            = "bg-white rounded-xl border border-slate-200 shadow-sm";
export const CARD_PADDED     = "bg-white rounded-xl border border-slate-200 shadow-sm p-6";
export const CARD_HOVER      = "bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow duration-200";

// ── Typography ───────────────────────────────────────────────────────────────
export const H1              = "text-2xl font-bold text-slate-900 tracking-tight";
export const H2              = "text-xl font-bold text-slate-800";
export const H3              = "text-sm font-semibold text-slate-700 uppercase tracking-wide";
export const LABEL           = "text-xs font-semibold text-slate-500 uppercase tracking-wide";
export const BODY            = "text-sm text-slate-700";
export const MUTED           = "text-xs text-slate-400";

// ── Buttons ──────────────────────────────────────────────────────────────────
export const BTN_PRIMARY     = "inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors duration-150 active:scale-95";
export const BTN_SECONDARY   = "inline-flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold px-4 py-2 rounded-lg border border-slate-200 transition-colors duration-150";
export const BTN_DANGER      = "inline-flex items-center gap-2 bg-white hover:bg-red-50 text-red-600 text-sm font-semibold px-4 py-2 rounded-lg border border-red-200 transition-colors duration-150";
export const BTN_GHOST       = "inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors duration-150";

// ── Inputs ───────────────────────────────────────────────────────────────────
export const INPUT           = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all";
export const SELECT          = "border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all";

// ── Badges — compact pill system (20% tighter than default) ─────────────────
export const BADGE_SUCCESS   = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200";
export const BADGE_WARNING   = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200";
export const BADGE_ERROR     = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200";
export const BADGE_INFO      = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200";
export const BADGE_NEUTRAL   = "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200";

// ── Section header ───────────────────────────────────────────────────────────
export const SECTION_HEADER  = "flex items-center justify-between mb-4";

// ── Table styles ─────────────────────────────────────────────────────────────
export const TABLE_WRAPPER   = "overflow-hidden rounded-xl border border-slate-200";
export const TH              = "px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 border-b border-slate-200";
export const TD              = "px-4 py-3 text-sm text-slate-700 border-b border-slate-100";

// ── Divider ──────────────────────────────────────────────────────────────────
export const DIVIDER         = "w-full h-px bg-slate-100";

// ── Empty state ──────────────────────────────────────────────────────────────
export const EMPTY_STATE     = "flex flex-col items-center justify-center py-16 text-slate-400";

// ── Loading spinner ──────────────────────────────────────────────────────────
export const SPINNER         = "w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin";

// ── Activity type tokens — ONE source of truth for all activity icons/colors ─
// Standard: call=green, note=blue, email=amber, task=amber, meeting=purple
// Used by ActivityComposer tabs, ActivityCard, feed filters, etc.
export const ACTIVITY_TYPES = [
  { id: "note",    label: "Add Note",    icon: "MessageSquare", iconColor: "text-blue-500",   iconBg: "bg-blue-50",   tabActiveColor: "text-blue-600",   tabActiveBorder: "border-blue-500",   badgeBg: "bg-blue-100 text-blue-800"   },
  { id: "call",    label: "Log Call",    icon: "Phone",         iconColor: "text-green-600",  iconBg: "bg-green-50",  tabActiveColor: "text-green-700",  tabActiveBorder: "border-green-500",  badgeBg: "bg-green-100 text-green-800" },
  { id: "email",   label: "Add Email",   icon: "Mail",          iconColor: "text-amber-600",  iconBg: "bg-amber-50",  tabActiveColor: "text-amber-700",  tabActiveBorder: "border-amber-500",  badgeBg: "bg-amber-100 text-amber-800" },
  { id: "task",    label: "Add Task",    icon: "CheckCircle2",  iconColor: "text-amber-500",  iconBg: "bg-amber-50",  tabActiveColor: "text-amber-600",  tabActiveBorder: "border-amber-500",  badgeBg: "bg-amber-100 text-amber-800" },
  { id: "meeting", label: "Add Meeting", icon: "Calendar",      iconColor: "text-purple-600", iconBg: "bg-purple-50", tabActiveColor: "text-purple-700", tabActiveBorder: "border-purple-500", badgeBg: "bg-purple-100 text-purple-800" },
];

// ── KPI stat card helper ─────────────────────────────────────────────────────
export function kpiCardClass(color) {
  const map = {
    blue:    "bg-blue-50 border-blue-100",
    emerald: "bg-emerald-50 border-emerald-100",
    amber:   "bg-amber-50 border-amber-100",
    red:     "bg-red-50 border-red-100",
    violet:  "bg-violet-50 border-violet-100",
    slate:   "bg-slate-50 border-slate-200",
  };
  return `${CARD} ${map[color] || map.slate} p-5`;
}

export function kpiIconClass(color) {
  const map = {
    blue:    "bg-blue-100 text-blue-600",
    emerald: "bg-emerald-100 text-emerald-600",
    amber:   "bg-amber-100 text-amber-700",
    red:     "bg-red-100 text-red-600",
    violet:  "bg-violet-100 text-violet-600",
    slate:   "bg-slate-100 text-slate-600",
  };
  return `w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${map[color] || map.slate}`;
}