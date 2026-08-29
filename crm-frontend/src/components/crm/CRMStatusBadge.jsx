import { statusBadge } from "@/lib/crmDesignSystem";

export default function CRMStatusBadge({ children, variant = "neutral", icon: Icon, className = "" }) {
  const badgeStyle = {
    success: statusBadge.success,
    warning: statusBadge.warning,
    error: statusBadge.error,
    info: statusBadge.info,
    neutral: statusBadge.neutral,
  }[variant] || statusBadge.neutral;

  return (
    <span className={`${badgeStyle} ${className}`}>
      {Icon && <Icon className="w-3 h-3" />}
      {children}
    </span>
  );
}