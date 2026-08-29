/**
 * Unified Button Component System
 * Consistent heights, radius, and hover behavior
 * Uses design tokens for standardization
 */

export function Button({ children, onClick, disabled = false, variant = "primary", size = "md", className = "" }) {
  const baseClass = "typography-button transition-all duration-150 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed";
  
  const sizeClass = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
  }[size];

  const variantClass = {
    primary:    "bg-amber-600 text-white hover:bg-amber-700 active:scale-95",
    secondary:  "bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200",
    destructive: "bg-red-600 text-white hover:bg-red-700 active:scale-95",
    outline:    "border border-slate-200 text-slate-700 hover:bg-slate-50",
    ghost:      "text-slate-600 hover:bg-slate-50",
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${baseClass} ${sizeClass} ${variantClass} ${className}`}
    >
      {children}
    </button>
  );
}

export function IconButton({ children, onClick, disabled = false, className = "" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-8 w-8 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-100 transition-colors duration-150 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function CompactButton({ children, onClick, disabled = false, className = "" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`typography-button h-8 px-3 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors duration-150 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}