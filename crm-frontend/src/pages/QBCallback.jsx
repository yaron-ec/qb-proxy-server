/**
 * QuickBooks OAuth Callback Page
 * Intuit redirects here after user authorizes.
 * URL: /qb-callback?code=...&realmId=...&state=qb_oauth
 * 
 * This page exchanges the code for tokens via qbAuth backend function,
 * then closes the popup (or redirects to settings).
 */
import { useEffect, useState } from "react";
import { railwayRequest } from "@/lib/railwayClient";
import { CheckCircle, AlertTriangle, Loader2 } from "lucide-react";

export default function QBCallback() {
  const [status, setStatus] = useState("loading"); // loading | success | error
  const [detail, setDetail] = useState("");
  const [debugInfo, setDebugInfo] = useState({});

  useEffect(() => {
    handleCallback();
  }, []);

  const handleCallback = async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const realmId = params.get("realmId");
    const state = params.get("state");
    const error = params.get("error");
    const errorDesc = params.get("error_description");

    const debug = {
      url: window.location.href,
      code: code ? code.slice(0, 20) + "..." : "MISSING",
      realmId: realmId || "MISSING",
      state: state || "MISSING",
      error: error || null,
      errorDesc: errorDesc || null,
    };
    setDebugInfo(debug);
    console.log("[QBCallback] Params:", debug);

    // Intuit returned an error
    if (error) {
      console.error("[QBCallback] Intuit error:", error, errorDesc);
      setStatus("error");
      setDetail(`Intuit error: ${error} — ${errorDesc || "No description"}`);
      return;
    }

    if (!code) {
      setStatus("error");
      setDetail("No authorization code received from Intuit. The URL is missing the 'code' parameter.");
      return;
    }

    if (!realmId) {
      setStatus("error");
      setDetail("No realmId received from Intuit. Cannot identify your QuickBooks company.");
      return;
    }

    // If opened as a popup, send code+realmId back to opener to do the token exchange
    // (the popup may not have auth session, so the authenticated opener handles it)
    if (window.opener && !window.opener.closed) {
      try {
        console.log("[QBCallback] Sending OAuth code to opener popup...");
        window.opener.postMessage({ type: "QB_OAUTH_CODE", code, realmId }, "*");
        setStatus("success");
        setDetail(`Authorization received! Completing connection...`);
        setTimeout(() => window.close(), 2000);
      } catch (e) {
        console.error("[QBCallback] postMessage error:", e.message);
        setStatus("error");
        setDetail(`Failed to communicate with opener: ${e.message}`);
      }
      return;
    }

    // Not a popup — do the token exchange directly (user navigated here directly)
    try {
      console.log("[QBCallback] Exchanging code for tokens...");
      const redirectUri = `${window.location.origin}/qb-callback`;
      console.log("[QBCallback] Using redirectUri:", redirectUri);
      const res = await railwayRequest('/qb/auth-callback', {
        method: 'POST',
        body: {
          code,
          realmId,
          redirect_uri: redirectUri,
        },
      });

      if (res?.error) {
        setStatus("error");
        setDetail(`Token exchange failed: ${res.error}`);
        console.error("[QBCallback] Token exchange error:", res);
        return;
      }

      if (res?.success) {
        setStatus("success");
        setDetail(`Connected! Realm ID: ${realmId}`);
        setTimeout(() => { window.location.href = "/settings"; }, 2000);
      } else {
        setStatus("error");
        setDetail("Unexpected response from server.");
      }
    } catch (e) {
      console.error("[QBCallback] Exception:", e);
      setStatus("error");
      setDetail(`Exception during token exchange: ${e.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-8 max-w-md w-full text-center">
        <div className="text-3xl mb-4">💼</div>
        <h1 className="text-lg font-bold text-slate-800 mb-2">QuickBooks Connection</h1>

        {status === "loading" && (
          <div className="space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-[#2CA01C] mx-auto" />
            <p className="text-sm text-slate-600">Exchanging authorization code for tokens...</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-3">
            <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto" />
            <p className="text-sm font-semibold text-emerald-700">Successfully connected!</p>
            <p className="text-xs text-slate-500">{detail}</p>
            <p className="text-xs text-slate-400">This window will close automatically...</p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-3 text-left">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto" />
            <p className="text-sm font-semibold text-red-700 text-center">Connection Failed</p>
            <div className="bg-red-50 border border-red-200 rounded p-3">
              <p className="text-xs text-red-700 font-mono break-all">{detail}</p>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs font-mono space-y-1">
              <p className="font-bold text-slate-600 mb-1">Debug Info:</p>
              {Object.entries(debugInfo).map(([k, v]) => v && (
                <div key={k} className="flex gap-2">
                  <span className="text-slate-400 flex-shrink-0">{k}:</span>
                  <span className="text-slate-700 break-all">{String(v)}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => window.close()}
              className="w-full bg-slate-100 text-slate-700 py-2 text-sm font-semibold rounded hover:bg-slate-200 transition-colors"
            >
              Close Window
            </button>
          </div>
        )}
      </div>
    </div>
  );
}