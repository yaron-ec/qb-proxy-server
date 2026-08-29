import { useState, useEffect } from "react";
import * as railwaySettings from "@/api/railway/settings";
import { apiCall } from "@/api/railway/client";
import { AlertCircle, CheckCircle2, Lock } from "lucide-react";

export default function HandoffConfigTab() {
  const [phone, setPhone] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [step, setStep] = useState("phone"); // phone | verify | connected
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [settingsId, setSettingsId] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectedPhone, setConnectedPhone] = useState("");

  useEffect(() => {
    railwaySettings.get("handoff_config").then(s => {
      if (s && s.value?.is_connected) {
        setIsConnected(true);
        setStep("connected");
        setSettingsId(s.id || "handoff_config");
        setConnectedPhone(s.value?.phone || "");
      }
    }).catch(() => {});
  }, []);

  const handlePhoneSubmit = async (e) => {
    e.preventDefault();
    if (!phone.trim()) {
      setStatus("error");
      setStatusMessage("Phone number is required");
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const result = await apiCall('/api/v1/handoff/auth', {
        method: 'POST',
        body: {
          action: 'login',
          phone: phone.trim(),
        },
      }).catch(e => ({ success: false, error: e.message }));

      if (result?.success) {
        setStatus("success");
        setStatusMessage("Verification code sent to your phone");
        setStep("verify");
      } else {
        setStatus("error");
        setStatusMessage(result.data?.error || "Failed to send verification code");
      }
    } catch (e) {
      console.error("Phone auth error:", e);
      setStatus("error");
      setStatusMessage(e.message || "Failed to authenticate with Handoff");
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!verificationCode.trim()) {
      setStatus("error");
      setStatusMessage("Verification code is required");
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const result = await apiCall('/api/v1/handoff/auth', {
        method: 'POST',
        body: {
          action: 'verify',
          phone: phone.trim(),
          code: verificationCode.trim(),
        },
      }).catch(e => ({ success: false, error: e.message }));

      if (result?.success) {
        // Save to Settings
        const value = {
          is_connected: true,
          phone: phone.trim(),
          verified_at: new Date().toISOString(),
        };

        await railwaySettings.upsert("handoff_config", value, "text");
        setSettingsId("handoff_config");

        setStatus("success");
        setStatusMessage("Connected to Handoff!");
        setConnectedPhone(phone.trim());
        setIsConnected(true);
        setStep("connected");
      } else {
        setStatus("error");
        setStatusMessage(result.data?.error || "Verification failed");
      }
    } catch (e) {
      console.error("Verification error:", e);
      setStatus("error");
      setStatusMessage(e.message || "Failed to verify code");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect from Handoff? You'll need to log in again to reconnect.")) {
      return;
    }

    setSaving(true);
    try {
      await railwaySettings.upsert("handoff_config", { is_connected: false }, "text");

      setIsConnected(false);
      setStep("phone");
      setPhone("");
      setVerificationCode("");
      setStatus("success");
      setStatusMessage("Disconnected from Handoff");
      setTimeout(() => setStatus(null), 3000);
    } catch (e) {
      console.error("Disconnect error:", e);
      setStatus("error");
      setStatusMessage("Failed to disconnect");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-xs font-semibold text-blue-900 mb-2">🔐 Handoff Authentication</p>
        <p className="text-xs text-blue-800">
          Connect your Handoff account using your username and password. You'll receive a verification code via phone to confirm the connection.
        </p>
      </div>

      {/* Phone Step */}
      {step === "phone" && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <h3 className="text-sm font-semibold text-slate-900">Connect to Handoff</h3>
          <p className="text-xs text-slate-600">Enter your phone number to receive a verification code.</p>

          <form onSubmit={handlePhoneSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Phone Number *</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 123-4567"
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                disabled={saving}
                autoFocus
              />
              <p className="text-[10px] text-slate-500 mt-1">Verification code will be sent via SMS.</p>
            </div>

            {status && (
              <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${
                status === "success"
                  ? "bg-emerald-50 border border-emerald-200"
                  : "bg-red-50 border border-red-200"
              }`}>
                {status === "success" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <p className={`text-xs ${status === "success" ? "text-emerald-700" : "text-red-700"}`}>
                  {statusMessage}
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={saving || !phone.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Sending code...
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  Send Verification Code
                </>
              )}
            </button>
          </form>
        </div>
      )}

      {/* Verification Step */}
      {step === "verify" && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <h3 className="text-sm font-semibold text-slate-900">Verify Your Phone</h3>
          <p className="text-xs text-slate-600">
            A verification code has been sent to {phone}. Enter it below to complete the connection.
          </p>

          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Verification Code *</label>
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="000000"
                maxLength="6"
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-center font-mono text-lg letter-spacing"
                disabled={saving}
              />
            </div>

            {status && (
              <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${
                status === "success"
                  ? "bg-emerald-50 border border-emerald-200"
                  : "bg-red-50 border border-red-200"
              }`}>
                {status === "success" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <p className={`text-xs ${status === "success" ? "text-emerald-700" : "text-red-700"}`}>
                  {statusMessage}
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={saving || !verificationCode.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Verifying..." : "Verify & Connect"}
            </button>
          </form>

          <button
            onClick={() => setStep("login")}
            disabled={saving}
            className="w-full px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Back to Login
          </button>
        </div>
      )}

      {/* Connected Step */}
      {step === "connected" && isConnected && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Connected to Handoff</h3>
              <p className="text-xs text-slate-500">{connectedPhone}</p>
            </div>
          </div>

          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
            <p className="text-xs text-emerald-800">
              ✓ You can now create estimates in Handoff from the CRM. Click "Create Estimate in Handoff" on any lead to get started.
            </p>
          </div>

          <button
            onClick={handleDisconnect}
            disabled={saving}
            className="w-full px-4 py-2.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
          >
            Disconnect from Handoff
          </button>
        </div>
      )}

      <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
        <p className="text-xs font-semibold text-slate-700 mb-3">Integration features:</p>
        <ul className="text-xs text-slate-600 space-y-2">
          <li>✓ Create estimates directly from the CRM</li>
          <li>✓ Customer information auto-fills in Handoff</li>
          <li>✓ Estimates sync back automatically</li>
          <li>✓ Phone verification for secure connection</li>
        </ul>
      </div>
    </div>
  );
}