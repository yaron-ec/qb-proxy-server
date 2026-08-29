import { useState, useEffect, useRef } from "react";
import { apiCall } from "@/api/railway/client";
import { railwayRequest } from "@/lib/railwayClient";
import {
  ChevronRight, Check, AlertCircle, Loader2, User, Receipt,
  CreditCard, RotateCcw, Copy, Clock
} from "lucide-react";

const STEPS = [
  { id: 1, label: "Create Customer", icon: User },
  { id: 2, label: "Create Invoice", icon: Receipt },
  { id: 3, label: "Record Payment", icon: CreditCard },
  { id: 4, label: "Sync Status", icon: RotateCcw },
];

const INVOICE_STATE = {
  IDLE: 'idle',
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
  TIMEOUT: 'timeout',
};

export default function InvoiceCreationFlow({ lead, onLeadUpdate, qbConnected, dealId, dealAmount, dealProjectType }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [state, setState] = useState(INVOICE_STATE.IDLE);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [collapsing, setCollapsing] = useState(false);
  
  // Timeout & watchdog protection
  const timeoutRef = useRef(null);
  const watchdogRef = useRef(null);
  const isMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  // Detect if invoice already exists in QB (auto-recovery)
  useEffect(() => {
    if (lead.qb_invoice_id && state === INVOICE_STATE.LOADING) {
      console.log('[InvoiceCreationFlow] Auto-recovery: QB invoice detected while loading', lead.qb_invoice_id);
      clearTimeouts();
      if (isMountedRef.current) {
        setSuccess({
          invoiceNumber: lead.qb_invoice_number || lead.qb_invoice_id,
          invoiceAmount: lead.qb_invoice_amount,
        });
        setState(INVOICE_STATE.SUCCESS);
        setCurrentStep(3);
      }
    } else if (lead.qb_invoice_id && state === INVOICE_STATE.IDLE) {
      // Invoice exists, show success state
      setSuccess({
        invoiceNumber: lead.qb_invoice_number || lead.qb_invoice_id,
        invoiceAmount: lead.qb_invoice_amount,
      });
      setCurrentStep(3);
    } else if (!lead.qb_invoice_id && state === INVOICE_STATE.IDLE) {
      setCurrentStep(1);
      setSuccess(null);
    }
  }, [lead.qb_invoice_id, lead.qb_invoice_number, lead.qb_invoice_amount, state]);

  const clearTimeouts = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  const resetState = () => {
    console.log('[InvoiceCreationFlow] Resetting state to IDLE');
    clearTimeouts();
    if (isMountedRef.current) {
      setState(INVOICE_STATE.IDLE);
    }
  };

  const handleCreateInvoice = async () => {
    if (state !== INVOICE_STATE.IDLE && state !== INVOICE_STATE.ERROR && state !== INVOICE_STATE.TIMEOUT) {
      console.log('[InvoiceCreationFlow] Already in progress, ignoring duplicate click');
      return;
    }

    console.log('[InvoiceCreationFlow] Invoice creation started');
    setError(null);
    setSuccess(null);
    
    if (!isMountedRef.current) return;
    setState(INVOICE_STATE.LOADING);

    try {
      // Set 20s timeout for QB response
      timeoutRef.current = setTimeout(() => {
        console.warn('[InvoiceCreationFlow] 20s timeout reached');
        if (isMountedRef.current) {
          setState(INVOICE_STATE.TIMEOUT);
          setError('QuickBooks response timeout. Please try again.');
        }
      }, 20000);

      // Set 30s watchdog to force reset if stuck
      watchdogRef.current = setTimeout(() => {
        console.warn('[InvoiceCreationFlow] 30s watchdog triggered - force reset');
        if (isMountedRef.current) {
          setState(INVOICE_STATE.IDLE);
          setError('Operation took too long. Please refresh and try again.');
        }
        clearTimeouts();
      }, 30000);

      // Step 1: Ensure customer exists in QB
      console.log('[InvoiceCreationFlow] Starting customer sync for lead:', lead.id);
      
      if (!lead.qb_customer_id) {
        const customerRes = await railwayRequest('/qb/sync-lead', { lead });
        
        if (customerRes.status === 202) {
          let attempts = 0;
          let customerFound = false;
          
          while (attempts < 10 && !customerFound) {
            await new Promise(r => setTimeout(r, 500));
            
            if (!isMountedRef.current) return;
            
            const updated = await apiCall(`/api/v1/leads/${lead.id}`, { method: 'GET' });
            if (updated.qb_customer_id) {
              console.log('[InvoiceCreationFlow] Customer synced:', updated.qb_customer_id);
              customerFound = true;
              break;
            }
            
            if (updated.qb_last_sync_result === "error" && updated.qb_last_error) {
              throw new Error(`Customer sync failed: ${updated.qb_last_error}`);
            }
            
            attempts++;
          }
          
          if (!customerFound) {
            throw new Error("Customer sync is taking too long. Please try again.");
          }
        } else if (customerRes.data?.error) {
          throw new Error(customerRes.data.error);
        }
      } else {
        console.log('[InvoiceCreationFlow] Customer already exists:', lead.qb_customer_id);
      }

      // Step 2: Create invoice
      console.log('[InvoiceCreationFlow] Creating invoice...');
      const invoiceRes = await railwayRequest('/qb/sync-lead', {
        lead,
        action: 'sync_invoice',
        projectId: lead.id,
        autoCreateCustomer: false,
        ...(dealId && { dealId, dealAmount, dealProjectType }),
      });

      if (invoiceRes.status === 202) {
        let attempts = 0;
        const maxAttempts = 20;
        let invoiceFound = false;

        while (attempts < maxAttempts && !invoiceFound) {
          await new Promise(r => setTimeout(r, 500));
          
          if (!isMountedRef.current) return;

          const updated = await apiCall(`/api/v1/leads/${lead.id}`, { method: 'GET' });

          if (updated.qb_invoice_id) {
            console.log('[InvoiceCreationFlow] QB response received - invoice created');
            onLeadUpdate?.(updated);
            
            // Trigger PDF fetching from QB in background
            railwayRequest('/qb/fetch-estimate-pdf', { estimate_id: lead.id }).catch(e => console.warn('[InvoiceCreationFlow] PDF fetch failed:', e.message));
            
            if (isMountedRef.current) {
              setSuccess({
                invoiceNumber: updated.qb_invoice_number || updated.qb_invoice_id,
                invoiceAmount: updated.qb_invoice_amount,
              });
              console.log('[InvoiceCreationFlow] Invoice UI updated');
              setState(INVOICE_STATE.SUCCESS);
              setCurrentStep(3);
              invoiceFound = true;
              clearTimeouts();
              
              // Auto-collapse after 3 seconds
              setTimeout(() => {
                if (isMountedRef.current) setCollapsing(true);
              }, 3000);
            }
            return;
          }

          if (updated.qb_last_sync_result === "error" && updated.qb_last_error) {
            throw new Error(updated.qb_last_error);
          }

          attempts++;
        }

        throw new Error("Invoice creation is taking too long. Please check QuickBooks dashboard.");
      } else if (invoiceRes.data?.error) {
        throw new Error(invoiceRes.data.error);
      } else {
        throw new Error("Unexpected response from QuickBooks");
      }
    } catch (e) {
      console.error('[InvoiceCreationFlow] Error:', e);
      if (isMountedRef.current) {
        setError(e.message || "Failed to create invoice");
        setState(INVOICE_STATE.ERROR);
        setCurrentStep(1);
      }
    } finally {
      console.log('[InvoiceCreationFlow] Loading reset complete');
      clearTimeouts();
    }
  };

  // Don't show if invoice already exists
  if (lead.qb_invoice_id && !error && !collapsing) {
    return null;
  }

  const isReadyToCreate = qbConnected && lead.status === "Sold";
  const isLoading = state === INVOICE_STATE.LOADING;
  const isTimeout = state === INVOICE_STATE.TIMEOUT;
  
  const missingItems = [];
  if (!qbConnected) missingItems.push("QuickBooks connection");
  if (lead.status !== "Sold") missingItems.push("Lead must be marked as Sold");

  return (
    <div className={`card-premium p-5 transition-all duration-300 ${collapsing ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}>
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-xs font-bold text-slate-900 uppercase tracking-widest mb-3">
          📋 Invoice Workflow
        </h3>
      </div>

      {/* Success State */}
      {success && !error && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-3">
            <Check className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-bold text-emerald-900 text-sm">✓ Invoice Created Successfully</p>
              <div className="mt-2 space-y-1 text-xs text-emerald-800">
                <div className="flex items-center justify-between bg-white rounded px-2 py-1">
                  <span className="font-semibold">Invoice #:</span>
                  <div className="flex items-center gap-2">
                    <code className="font-mono font-bold">{success.invoiceNumber}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(String(success.invoiceNumber));
                      }}
                      className="text-emerald-600 hover:text-emerald-700 transition-colors"
                      title="Copy invoice number"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-white rounded px-2 py-1">
                  <span className="font-semibold">Amount:</span>
                  <span className="font-bold">${(success.invoiceAmount || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
              <p className="text-[11px] text-emerald-700 mt-3 font-semibold">👇 Scroll down to record payment →</p>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-red-900 text-sm">⚠ Invoice Creation Failed</p>
              <p className="text-xs text-red-700 mt-1 font-mono bg-white rounded px-2 py-1">{error}</p>
              <p className="text-[11px] text-red-600 mt-2">Check QB connection or contact support</p>
            </div>
          </div>
        </div>
      )}

      {/* Missing Prerequisites */}
      {!isReadyToCreate && !success && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-amber-900">Cannot create invoice yet:</p>
              <ul className="text-xs text-amber-700 mt-1 space-y-0.5">
                {missingItems.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Step Progress */}
      <div className="space-y-2 mb-5">
        {STEPS.map((step, idx) => {
          const Icon = step.icon;
          const isActive = step.id === currentStep;
          const isComplete = step.id < currentStep || (success && step.id <= 3);

          return (
            <div key={step.id} className="flex items-center gap-3">
              {/* Step Indicator */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 transition-all ${
                  isComplete
                    ? "bg-emerald-100 text-emerald-700"
                    : isActive
                    ? "bg-orange text-white ring-2 ring-orange ring-offset-2"
                    : "bg-slate-100 text-slate-400"
                }`}
              >
                {isComplete ? <Check className="w-4 h-4" /> : step.id}
              </div>

              {/* Step Content */}
              <div className="flex-1 min-w-0">
                <p
                  className={`text-xs font-semibold transition-colors ${
                    isActive
                      ? "text-orange"
                      : isComplete
                      ? "text-emerald-600"
                      : "text-slate-400"
                  }`}
                >
                  {step.label}
                </p>
              </div>

              {/* Right Arrow (between steps) */}
              {idx < STEPS.length - 1 && (
                <ChevronRight
                  className={`w-4 h-4 flex-shrink-0 transition-colors ${
                    isComplete ? "text-emerald-400" : "text-slate-200"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Primary Action Button */}
      {!success && (
        <button
          onClick={handleCreateInvoice}
          disabled={isLoading || !isReadyToCreate}
          title={!isReadyToCreate ? "Complete prerequisites first" : ""}
          className={`w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-lg transition-all ${
            isLoading
              ? "bg-yellow-500 text-white cursor-wait"
              : isTimeout
              ? "bg-orange text-white hover:shadow-lg hover:shadow-orange/40 active:scale-95"
              : isReadyToCreate
              ? "bg-gradient-to-r from-orange to-amber-600 text-white hover:shadow-lg hover:shadow-orange/40 active:scale-95"
              : "bg-slate-100 text-slate-400 cursor-not-allowed"
          }`}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              🟡 Creating Invoice…
            </>
          ) : isTimeout ? (
            <>
              <Clock className="w-4 h-4" />
              🟠 Retry Invoice Sync
            </>
          ) : error ? (
            <>
              <AlertCircle className="w-4 h-4" />
              🔴 Invoice Failed
            </>
          ) : (
            <>
              <Receipt className="w-4 h-4" />
              Create Invoice in QuickBooks
            </>
          )}
        </button>
      )}

      {/* Success - Show Next Step */}
      {success && !error && state === INVOICE_STATE.SUCCESS && (
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-4 py-3">
          <Check className="w-4 h-4" />
          🟢 Invoice Created • Next: Record payment below →
        </div>
      )}

      {/* Timeout - Show Retry */}
      {isTimeout && (
        <div className="flex items-center gap-2 text-xs font-semibold text-orange bg-orange/10 rounded-lg px-4 py-3">
          <Clock className="w-4 h-4" />
          🟠 QB response timeout — try again
        </div>
      )}

      {/* Info Text */}
      <p className="text-[10px] text-slate-500 mt-4 leading-relaxed">
        <strong>How it works:</strong> Create customer in QuickBooks, then generate invoice. After invoice is created, you'll be able to record payments below.
      </p>
    </div>
  );
}