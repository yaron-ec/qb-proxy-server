/**
 * Unified Card Component System
 * Consistent padding, spacing, shadows, and borders
 * Uses design tokens for premium SaaS appearance
 */

export function Card({ children, className = "", hover = true }) {
  return (
    <div 
      className={`bg-white rounded-lg border border-slate-200 shadow-sm ${hover ? 'hover:shadow-md hover:border-slate-300' : ''} transition-all duration-150 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className = "" }) {
  return <div className={`px-4 py-3 border-b border-slate-100 ${className}`}>{children}</div>;
}

export function CardContent({ children, className = "" }) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

export function CardFooter({ children, className = "" }) {
  return <div className={`px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-2 ${className}`}>{children}</div>;
}

export function KPICard({ label, value, color = "bg-slate-50", textColor = "text-slate-700" }) {
  return (
    <Card className={`${color} p-4 flex flex-col gap-2 min-w-0 justify-center`}>
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide leading-tight truncate">{label}</p>
      <p className={`text-base font-bold truncate ${textColor}`}>{value}</p>
    </Card>
  );
}