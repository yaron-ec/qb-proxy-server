/**
 * Unified Empty State Component System
 * Premium appearance with icons and clear messaging
 */

import { Card } from "./Card";

export function EmptyState({ icon: Icon, title, description, action = null }) {
  return (
    <Card className="py-12 px-6 text-center">
      <div className="flex flex-col items-center gap-4 max-w-sm mx-auto">
        {Icon && <Icon className="w-14 h-14 text-slate-200" />}
        <div>
          <h3 className="typography-empty-state-title mb-1">{title}</h3>
          {description && <p className="typography-helper-text">{description}</p>}
        </div>
        {action && <div className="pt-3">{action}</div>}
      </div>
    </Card>
  );
}

export function TableEmptyState({ message = "No data found" }) {
  return (
    <div className="py-16 text-center typography-helper-text">
      {message}
    </div>
  );
}