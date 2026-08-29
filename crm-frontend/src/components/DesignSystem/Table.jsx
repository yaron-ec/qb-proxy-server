/**
 * Unified Table Component
 * Minimal, clean table styles
 */

export function Table({ children, className = "" }) {
  return (
    <div className={`border border-slate-200 rounded-lg overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function TableHeader({ children }) {
  return (
    <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center gap-3">
      {children}
    </div>
  );
}

export function TableRow({ children, href = null, onClick = null, className = "" }) {
  const baseClass = "border-b border-slate-100 last:border-0 px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors";
  
  if (href) {
    return <a href={href} className={`${baseClass} cursor-pointer ${className}`}>{children}</a>;
  }
  
  if (onClick) {
    return <div onClick={onClick} className={`${baseClass} cursor-pointer ${className}`}>{children}</div>;
  }
  
  return <div className={`${baseClass} ${className}`}>{children}</div>;
}

export function TableCell({ children, className = "" }) {
  return <div className={`flex-1 min-w-0 ${className}`}>{children}</div>;
}