/**
 * AutomationBlockedBanner
 * Shows a red warning banner when workspace automation credits are exhausted.
 * This is a pure UI component — no API calls, no credits consumed.
 * The banner is always shown (the platform confirms credits are exhausted).
 */
import { AlertTriangle } from 'lucide-react';

export default function AutomationBlockedBanner({ className = '' }) {
  return (
    <div className={`flex items-start gap-3 bg-red-600 text-white rounded-lg px-4 py-3 ${className}`}>
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <p className="text-xs font-semibold leading-relaxed">
        <span className="font-black">⚠ Automation workflows are currently blocked</span> due to Integration Credits being exhausted.
        Calendar sync, appointment reminders, contact sync, and all scheduled syncs will not run until credits reset on <span className="font-black">June 30, 2026</span>.
      </p>
    </div>
  );
}