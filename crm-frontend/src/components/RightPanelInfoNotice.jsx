/**
 * RightPanelInfoNotice - Unified info/warning notice for right-side panels
 * 
 * Ensures consistent:
 * - Blue background and border
 * - Icon style and placement
 * - Title (typography-message-title)
 * - Description text
 * - Padding and spacing
 */

import { Info } from "lucide-react";

export default function RightPanelInfoNotice({
  icon: Icon,
  title,
  description,
  type = "info", // 'info' | 'warning' | 'error' | 'success'
}) {
  const bgColorMap = {
    info: "bg-blue-50 border-blue-200",
    warning: "bg-amber-50 border-amber-200",
    error: "bg-red-50 border-red-200",
    success: "bg-emerald-50 border-emerald-200",
  };

  const textColorMap = {
    info: "text-blue-900",
    warning: "text-amber-900",
    error: "text-red-900",
    success: "text-emerald-900",
  };

  const iconColorMap = {
    info: "text-blue-600",
    warning: "text-amber-600",
    error: "text-red-600",
    success: "text-emerald-600",
  };

  return (
    <div className={`border rounded-lg p-4 space-y-2 ${bgColorMap[type]}`}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {Icon ? (
            <Icon className={`w-4 h-4 ${iconColorMap[type]}`} />
          ) : (
            <Info className={`w-4 h-4 ${iconColorMap[type]}`} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {title && (
            <h3 className={`typography-message-title ${textColorMap[type]}`}>
              {title}
            </h3>
          )}
          {description && (
            <p className={`text-sm mt-1 ${textColorMap[type]}`}>
              {description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}