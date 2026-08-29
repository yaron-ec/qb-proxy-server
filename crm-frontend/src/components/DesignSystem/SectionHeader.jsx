/**
 * Unified Section Header Component
 * Used for page titles, section groupings
 */

export function PageTitle({ children }) {
  return <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{children}</h1>;
}

export function PageSubtitle({ children }) {
  return <p className="text-sm text-slate-500 mt-0.5">{children}</p>;
}

export function SectionTitle({ children }) {
  return <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">{children}</h2>;
}

export function GroupLabel({ children }) {
  return <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-3 mb-1.5">{children}</p>;
}

export function HelperText({ children }) {
  return <p className="text-xs text-slate-500">{children}</p>;
}

export function Label({ children, required = false }) {
  return (
    <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
      {children}
      {required && <span className="text-red-500">*</span>}
    </label>
  );
}