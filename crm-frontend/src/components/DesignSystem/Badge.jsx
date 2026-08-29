/**
 * Unified Badge Component System
 * Consistent height, padding, radius, and typography across all badges
 * Uses design tokens for maintainability
 */

export function StatusBadge({ variant = "default", children, className = "" }) {
  const variants = {
    default:     "bg-slate-100 text-slate-700",
    success:     "bg-emerald-100 text-emerald-700",
    warning:     "bg-amber-100 text-amber-700",
    error:       "bg-red-100 text-red-600",
    info:        "bg-blue-100 text-blue-700",
    purple:      "bg-purple-100 text-purple-700",
    sold:        "bg-emerald-100 text-emerald-700",
    pending:     "bg-amber-100 text-amber-700",
    draft:       "bg-slate-100 text-slate-600",
    appointment: "bg-indigo-100 text-indigo-700",
    admin:       "bg-slate-700 text-slate-100",
    active:      "bg-emerald-100 text-emerald-700",
  };
  return (
    <span 
      className={`inline-flex items-center height-[1.5rem] px-2 py-0.5 rounded-full whitespace-nowrap typography-badge ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

export function ActionBadge({ children, onClick, variant = "default", disabled = false }) {
  const variants = {
    default:   "bg-slate-100 text-slate-700 hover:bg-slate-200",
    amber:     "bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100",
    emerald:   "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100",
  };
  
  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center h-6 px-2 py-0.5 rounded-full whitespace-nowrap typography-badge transition-colors disabled:opacity-50 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}