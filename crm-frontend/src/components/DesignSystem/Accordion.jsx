/**
 * Unified Accordion Component
 * Premium SaaS style with icon support and item counters
 */

import { ChevronDown } from "lucide-react";

export function AccordionItem({ 
  title, 
  icon: Icon, 
  badge = null, 
  isOpen, 
  onToggle, 
  children,
  color = "amber"
}) {
  const colorMap = {
    amber: "text-amber-600 bg-amber-50",
    blue: "text-blue-600 bg-blue-50",
    emerald: "text-emerald-600 bg-emerald-50",
    purple: "text-purple-600 bg-purple-50",
  };

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {Icon && <Icon className={`w-4 h-4 flex-shrink-0 ${colorMap[color]}`} />}
          <span className="text-sm font-semibold text-slate-800">{title}</span>
          {badge !== null && (
            <span className="text-xs font-bold bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full flex-shrink-0">
              {badge}
            </span>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && <div className="px-0 py-0 border-t border-slate-100 bg-white">{children}</div>}
    </div>
  );
}

export function AccordionContent({ children }) {
  return <div className="p-4">{children}</div>;
}