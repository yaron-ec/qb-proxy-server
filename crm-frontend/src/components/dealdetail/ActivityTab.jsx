/**
 * ActivityTab — placeholder for future activity/timeline/audit log.
 */
import { EmptyState } from "@/components/DesignSystem";
import { Clock } from "lucide-react";

export default function ActivityTab() {
  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5">
      <EmptyState
        icon={Clock}
        title="Activity feed coming soon"
        description="Call logs, emails, notes, and audit history will appear here in a future update."
      />
    </div>
  );
}