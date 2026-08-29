/**
 * RightPanelEmptyState - Unified empty state for all right-side panels
 * 
 * Ensures consistent:
 * - Centered icon (8x8, muted color)
 * - Title (typography-empty-state-title)
 * - Description text (typography-helper-text)
 * - Optional action button
 * - Padding and spacing
 */

export default function RightPanelEmptyState({
  icon: Icon,
  title,
  description,
  action,
}) {
  return (
    <div className="flex flex-col items-center text-center px-4 py-6 gap-2.5">
      {Icon && (
        <Icon className="w-8 h-8 text-slate-300" />
      )}
      {title && (
        <h3 className="typography-empty-state-title">{title}</h3>
      )}
      {description && (
        <p className="typography-helper-text">{description}</p>
      )}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}