/**
 * EC Construction Group CRM Global Design System
 * Single source of truth for all UI styling
 */

// ─── TYPOGRAPHY SYSTEM ───────────────────────────────────────────────────────
export const typography = {
  // Page titles — main headings (e.g., "Keith Cullom", "Dashboard")
  pageTitle: {
    className: "text-2xl font-bold text-slate-900 leading-tight",
    fontSize: "1.5rem",
    fontWeight: 700,
  },

  // Section headers — section group titles (e.g., "Project Info", "Financial Info")
  sectionHeader: {
    className: "text-xs font-semibold uppercase tracking-widest text-slate-500",
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.1em",
  },

  // Card titles — titles within cards (e.g., "Contact", "Payment Progress")
  cardTitle: {
    className: "text-sm font-semibold text-slate-800",
    fontSize: "0.875rem",
    fontWeight: 600,
  },

  // Field labels — form labels and data field names (e.g., "Owner / Sales Rep")
  fieldLabel: {
    className: "text-[10px] font-semibold text-slate-500 uppercase tracking-wide",
    fontSize: "0.625rem",
    fontWeight: 600,
    letterSpacing: "0.05em",
  },

  // Data values — the actual data displayed (e.g., "Yaron", "$45,000")
  dataValue: {
    className: "text-sm text-slate-900",
    fontSize: "0.875rem",
    fontWeight: 400,
  },

  // Body text — regular paragraph text
  body: {
    className: "text-xs text-slate-600",
    fontSize: "0.75rem",
    fontWeight: 400,
  },

  // Status badges — badge text (e.g., "Sold", "In Progress")
  statusBadge: {
    className: "text-xs font-semibold",
    fontSize: "0.75rem",
    fontWeight: 600,
  },

  // Button text
  button: {
    className: "text-xs font-semibold",
    fontSize: "0.75rem",
    fontWeight: 600,
  },

  // Helper text — small descriptive text
  helper: {
    className: "text-[10px] text-slate-400",
    fontSize: "0.625rem",
    fontWeight: 400,
  },

  // Metric value — large numbers in KPI cards
  metricValue: {
    className: "text-base font-bold text-slate-900",
    fontSize: "1rem",
    fontWeight: 700,
  },
};

// ─── COLOR PALETTE ──────────────────────────────────────────────────────────
export const colors = {
  // Primary brand colors
  primary: {
    navy: "#0f1c2e",
    gold: "#D4A017",
  },

  // Neutral palette
  neutral: {
    white: "#ffffff",
    slate50: "#f8fafc",
    slate100: "#f1f5f9",
    slate200: "#e2e8f0",
    slate300: "#cbd5e1",
    slate400: "#94a3b8",
    slate500: "#64748b",
    slate600: "#475569",
    slate700: "#334155",
    slate800: "#1e293b",
    slate900: "#0f172a",
  },

  // Status colors
  status: {
    success: {
      bg: "#ecfdf5",
      border: "#a7f3d0",
      text: "#047857",
    },
    warning: {
      bg: "#fef3c7",
      border: "#fde68a",
      text: "#b45309",
    },
    error: {
      bg: "#fee2e2",
      border: "#fecaca",
      text: "#dc2626",
    },
    info: {
      bg: "#dbeafe",
      border: "#bfdbfe",
      text: "#1e40af",
    },
  },
};

// ─── SPACING SYSTEM ────────────────────────────────────────────────────────
export const spacing = {
  xs: "0.25rem",   // 4px
  sm: "0.5rem",    // 8px
  md: "1rem",      // 16px
  lg: "1.5rem",    // 24px
  xl: "2rem",      // 32px
  xxl: "3rem",     // 48px
};

// ─── CARD STYLES ───────────────────────────────────────────────────────────
export const card = {
  base: "bg-card text-card-foreground border border-border rounded-lg shadow-sm",
  padding: "p-4",
  largeRadius: "rounded-lg",
  smallRadius: "rounded-lg",
};

// ─── BUTTON STYLES ───────────────────────────────────────────────────────────
export const button = {
  // Primary gold button
  primary:
    "px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50",

  // Secondary white button
  secondary:
    "px-4 py-2 text-xs font-semibold text-foreground bg-card border border-border hover:bg-secondary rounded-lg transition-colors disabled:opacity-50",

  // Danger red button
  danger:
    "px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50",

  // Success green button
  success:
    "px-4 py-2 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50",

  // Ghost button (minimal)
  ghost:
    "px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50",

  // Small icon button
  iconSmall:
    "w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50",
};

// ─── STATUS BADGE STYLES ───────────────────────────────────────────────────
export const statusBadge = {
  success:
    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-full",
  warning:
    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full",
  error:
    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full",
  info: "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-full",
  neutral:
    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-full",
};

// ─── INPUT STYLES ──────────────────────────────────────────────────────────
export const input = {
  base: "w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-card text-foreground",
  label: "text-[10px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5",
};

// ─── UTILITY FUNCTIONS ────────────────────────────────────────────────────────
export const getStatusColor = (status) => {
  const statusMap = {
    success: colors.status.success,
    warning: colors.status.warning,
    error: colors.status.error,
    info: colors.status.info,
  };
  return statusMap[status] || colors.status.info;
};

export const getStatusBadgeStyle = (status) => {
  const styleMap = {
    success: statusBadge.success,
    warning: statusBadge.warning,
    error: statusBadge.error,
    info: statusBadge.info,
  };
  return styleMap[status] || statusBadge.neutral;
};