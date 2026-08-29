/**
 * Alert — friendly alert banner with expandable details
 * Variants: info, warning, error, success
 */
import { useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Info, ChevronDown } from "lucide-react";

const VARIANT_CONFIG = {
  info:    { icon: Info,          bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-800",    iconColor: "text-blue-500" },
  warning: { icon: AlertTriangle, bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-800",   iconColor: "text-amber-500" },
  error:   { icon: AlertCircle,   bg: "bg-red-50",     border: "border-red-200",     text: "text-red-700",     iconColor: "text-red-500" },
  success: { icon: CheckCircle,   bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-800", iconColor: "text-emerald-500" },
};

export function Alert({ variant = "info", title, children, details = null, action = null, className = "" }) {
  const [showDetails, setShowDetails] = useState(false);
  const config = VARIANT_CONFIG[variant] || VARIANT_CONFIG.info;
  const Icon = config.icon;

  return (
    <div className={`rounded-lg border ${config.border} ${config.bg} px-3 py-2.5 ${className}`}>
      <div className="flex items-start gap-2">
        <Icon className={`w-3.5 h-3.5 ${config.iconColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          {title && <p className={`text-xs font-semibold ${config.text}`}>{title}</p>}
          {children && <p className={`text-xs ${config.text} mt-0.5 leading-snug`}>{children}</p>}
          {details && (
            <button
              onClick={() => setShowDetails(!showDetails)}
              className={`text-[10px] ${config.iconColor} hover:underline mt-1 flex items-center gap-0.5`}
            >
              <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
              Details
            </button>
          )}
          {showDetails && details && (
            <p className="text-[10px] mt-1 font-mono break-all opacity-60 leading-tight max-h-24 overflow-y-auto">
              {typeof details === "string" ? details.slice(0, 300) : JSON.stringify(details, null, 2)}
            </p>
          )}
          {action && <div className="mt-1.5">{action}</div>}
        </div>
      </div>
    </div>
  );
}