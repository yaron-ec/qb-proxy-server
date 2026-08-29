/**
 * SidePanel — collapsible panel section with consistent header.
 * Used in right-side panels and tab content sections.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";

export function SidePanel({ icon: Icon, title, badge = null, actions = null, children, defaultOpen = true, className = "" }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`border-b border-slate-100 ${className}`}>
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 min-w-0 flex-1"
        >
          {Icon && <Icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
          <span className="text-sm font-semibold text-slate-800 truncate">{title}</span>
          {badge != null && (
            <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full flex-shrink-0">
              {badge}
            </span>
          )}
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {actions}
          <button onClick={() => setIsOpen(!isOpen)} className="text-slate-400 hover:text-slate-600 btn-compact p-0.5">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
          </button>
        </div>
      </div>
      {isOpen && <div>{children}</div>}
    </div>
  );
}