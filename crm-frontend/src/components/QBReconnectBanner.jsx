import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { apiCall } from "@/api/railway/client";

// Admin-only warning when QuickBooks needs an OAuth reconnect. The server
// refreshes the access token on its own (lib/qbTokenManager); this only shows
// when Intuit has genuinely revoked/expired the grant, which a person must
// re-consent to on the Integrations page. A failed health read shows nothing —
// a network blip is never presented as a disconnect.
const POLL_MS = 10 * 60 * 1000;

export function needsQbReconnect(health) {
  if (!health) return false;
  return health.reconnectRequired === true || health.credentialStatus === "revoked";
}

export default function QBReconnectBanner({ user }) {
  const isAdmin = user?.role === "admin";
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    const check = () => apiCall("/qb/health", { method: "GET" })
      .then((h) => { if (!cancelled) setShow(needsQbReconnect(h)); })
      .catch(() => { /* keep the last known state */ });
    check();
    const t = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [isAdmin]);

  if (!isAdmin || !show) return null;
  return (
    <div role="alert" className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 text-sm">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">
        QuickBooks authorization was revoked or expired at Intuit, so QuickBooks sync is paused.
      </span>
      <Link to="/integrations" className="font-medium underline whitespace-nowrap">Reconnect QuickBooks</Link>
    </div>
  );
}
