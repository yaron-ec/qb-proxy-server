/**
 * FriendlyError — normalizes raw errors (404, HTML, proxy, stack traces)
 * into user-friendly messages, displayed via Alert.
 */
import { Alert } from "./Alert";

export function normalizeError(raw) {
  if (!raw) return null;
  const msg = String(typeof raw === "string" ? raw : (raw.message || raw)).trim();

  if (msg.includes("<!DOCTYPE") || msg.includes("<html")) {
    if (msg.includes("Cannot POST") || msg.includes("Cannot GET") || msg.includes("404")) {
      return { friendly: "Service is starting up. Please try again in a moment.", technical: msg.slice(0, 200) };
    }
    return { friendly: "Something went wrong. Please try again.", technical: msg.slice(0, 200) };
  }
  if (msg.includes("QUICKBOOKS_RECONNECT_REQUIRED") || msg.includes("reconnectRequired")) {
    return { friendly: "Connection expired. Reconnect in Settings.", technical: msg };
  }
  if (msg.includes("ENOTFOUND") || msg.includes("fetch failed") || msg.includes("NetworkError")) {
    return { friendly: "Cannot reach the service. Check your connection and try again.", technical: msg };
  }
  if (msg.includes("Builder+") || msg.includes("current plan") || msg.includes("402")) {
    return { friendly: "This feature is temporarily unavailable.", technical: msg };
  }

  const clean = msg.replace(/^Proxy \d+:\s*/, "").replace(/^QB \d+:\s*/, "");
  return {
    friendly: clean.length > 120 ? clean.slice(0, 120) + "…" : clean,
    technical: msg,
  };
}

export function FriendlyError({ error, title = "Something went wrong", action = null, className = "" }) {
  const normalized = normalizeError(error);
  if (!normalized) return null;

  return (
    <Alert
      variant="warning"
      title={title}
      details={normalized.technical}
      action={action}
      className={className}
    >
      {normalized.friendly}
    </Alert>
  );
}