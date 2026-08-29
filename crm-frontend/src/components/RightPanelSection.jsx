/**
 * RightPanelSection - Unified header for all right-side lead panels
 * 
 * Ensures consistent:
 * - Header height (px-4 py-3)
 * - Title styling (typography-card-title)
 * - Collapse arrow style and position
 * - Count badge placement and style
 * - Action button positioning
 */

import { ChevronDown, ChevronRight } from "lucide-react";

export default function RightPanelSection({
  title,
  count,
  collapsed,
  onCollapse,
  action,
  children,
  icon: Icon,
  hideHeader = false,
}) {
  return (
    <div>
      {/* Header — hidden when nested inside accordion */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50/50 transition-colors border-b border-slate-100">
          <button onClick={onCollapse} className="flex items-center gap-1.5 flex-1 min-w-0 btn-compact">
            {collapsed ? (
              <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />
            ) : (
              <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
            )}
            <span className="text-xs font-semibold text-slate-700">{title}</span>
            {count !== undefined && (
              <span className="text-[10px] text-slate-400 ml-0.5">({count})</span>
            )}
          </button>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      {/* Content */}
      {!collapsed && (
        <div className={hideHeader ? "" : ""}>
          {children}
        </div>
      )}
    </div>
  );
}