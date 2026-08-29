import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { EC_PROJECT_TYPES } from "@/lib/projectTypes";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { fetchCaptureAvailability, submitCapture } from "@/lib/captureRailwayClient";
import { useAuth } from "@/lib/AuthContext";
import { CheckCircle, Upload, X, Phone, MapPin, Briefcase, Clock, AlertCircle, Loader2, ArrowLeft, Calendar, ShieldAlert } from "lucide-react";
import CaptureSlotGrid from "@/components/CaptureSlotGrid";

// Server-side allowlist is authoritative; this mirror only gates the UI.
const ADMIN_OVERRIDE_EMAILS = ["yaron@ecconstructiongroup.com", "michelle@ecconstructiongroup.com"];

// Fallback defaults — imported from single source of truth
const DEFAULT_PROJECT_TYPES = EC_PROJECT_TYPES;
const DEFAULT_SOURCES = [
  "Google Search", "Google Maps / reviews", "Referral",
  "Instagram / Facebook", "YouTube", "Repeat customer", "Sharon", "Other",
];
const DEFAULT_OWNERS = ["Ethan Magen", "Micky Gad", "Yaron Drilevich"];

const TIMES = [];
for (let h = 7; h <= 19; h++) {
  for (let m = 0; m < 60; m += 30) {
    TIMES.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
}

function fmt12(t) {
  if (!t) return t;
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

const emptyForm = () => ({
  first_name: "", last_name: "", email: "", phone: "",
  property_address: "", city: "", zip_code: "",
  project_type: [], start_timeframe: "", budget_range: "",
  message: "", source: "", referral_name: "",
  owner_occupied: false,
  appointment_date: "", appointment_time: "",
  follow_up_date: "", follow_up_time: "", follow_up_type: "",
  assigned_rep: "Yaron Drilevich", estimated_value: "", notes: "",
  photo_urls: [],
});

export default function LeadCapture() {
  const navigate = useNavigate();
  const returnToCRM = new URLSearchParams(window.location.search).get("returnToCRM") === "true";
  const { user } = useAuth();

  // Admin override is allowed ONLY for Yaron / Michelle (server re-verifies).
  // Non-admins / public users never see the override affordance.
  const canOverride = !!user
    && user.role === "admin"
    && ADMIN_OVERRIDE_EMAILS.includes((user.email || "").toLowerCase());

  const [form, setForm] = useState(emptyForm());
  const [submitted, setSubmitted] = useState(false);
  const [submittedLead, setSubmittedLead] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState({});
  const [duplicateFound, setDuplicateFound] = useState(null);
  const [conflictOverride, setConflictOverride] = useState(false);
  const [availabilityError, setAvailabilityError] = useState(null);
  const [overrideActive, setOverrideActive] = useState(false); // current selection is an admin override
  const [overrideConfirm, setOverrideConfirm] = useState(null); // pending blocked slot awaiting confirmation

  const [projectTypes, setProjectTypes] = useState(DEFAULT_PROJECT_TYPES);
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [owners, setOwners] = useState(DEFAULT_OWNERS);

  // Appointment availability — fetched from the Railway availability endpoint
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);

  // Fetch Yaron's blocked slots from the Railway availability endpoint whenever
  // a date is selected. Availability is always shown for Yaron Drilevich per the
  // lead-entry flow. The Railway availabilityService applies the 1hr-before +
  // duration + 1hr-after buffer rule and merges overlapping windows.
  useEffect(() => {
    if (!form.appointment_date) {
      setBlockedSlots([]);
      setSlotsError(null);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    setSlotsError(null);
    fetchCaptureAvailability({ owner: 'Yaron Drilevich', date: form.appointment_date })
      .then(data => {
        if (cancelled) return;
        setBlockedSlots(data?.blocked_slots || []);
      })
      .catch(e => {
        if (cancelled) return;
        setBlockedSlots([]);
        setSlotsError('Could not load calendar availability. Please try a different date.');
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => { cancelled = true; };
  }, [form.appointment_date]);

  // Clear appointment_time if it becomes blocked after a date/owner change
  useEffect(() => {
    if (form.appointment_time && blockedSlots.includes(form.appointment_time)) {
      setForm(p => ({ ...p, appointment_time: "" }));
    }
  }, [blockedSlots]);

  const set = (k, v) => {
    setForm(p => ({ ...p, [k]: v }));
    if (['appointment_date', 'appointment_time', 'follow_up_date', 'follow_up_time', 'follow_up_type', 'assigned_rep'].includes(k)) {
      setAvailabilityError(null);
      setConflictOverride(false);
    }
    // Changing the date clears any active override (the slot set changes).
    if (k === 'appointment_date') {
      setOverrideActive(false);
      setOverrideConfirm(null);
    }
  };

  // Slot selection handler. For an available slot, select directly. For a
  // blocked slot (admin override), require an explicit confirmation first.
  const handleSelectTime = (t, opts) => {
    if (opts && opts.override) {
      if (!canOverride) return; // safety; grid hides the action for non-admins
      setOverrideConfirm(t); // show confirmation dialog
      return;
    }
    setOverrideActive(false);
    set("appointment_time", t);
  };

  const confirmOverride = () => {
    if (!overrideConfirm) return;
    setForm(p => ({ ...p, appointment_time: overrideConfirm }));
    setOverrideActive(true);
    setOverrideConfirm(null);
    setAvailabilityError(null);
  };

  const cancelOverride = () => {
    setOverrideConfirm(null);
    if (overrideActive) {
      setOverrideActive(false);
      setForm(p => ({ ...p, appointment_time: "" }));
    }
  };

  const toggleProjectType = (type) => {
    setForm(p => {
      const cur = p.project_type || [];
      return { ...p, project_type: cur.includes(type) ? cur.filter(t => t !== type) : [...cur, type] };
    });
  };

  const uploadFile = async (file) => {
    setUploading(true);
    try {
      // Upload directly to Railway → R2/S3 — zero Base44 integration credits
      const { url } = await uploadFileToStorage(file);
      set("photo_urls", [...form.photo_urls, url]);
    } catch (e) {
      alert("File upload is currently unavailable. You can submit without photos.");
    } finally {
      setUploading(false);
    }
  };

  const removeFile = (i) => set("photo_urls", form.photo_urls.filter((_, idx) => idx !== i));

  const validate = () => {
    const e = {};
    if (!form.first_name.trim()) e.first_name = "Required";
    if (!form.last_name.trim()) e.last_name = "Required";
    if (!form.phone.trim() && !form.email.trim()) e.phone = "Phone or email required";
    if (form.project_type.length === 0) e.project_type = "Select at least one project type";
    if (!form.source.trim()) e.source = "Required";
    if (!form.assigned_rep.trim()) e.assigned_rep = "Required";
    if (!form.appointment_date) e.appointment_date = "Required";
    if (!form.appointment_time) e.appointment_time = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const buildLeadPayload = () => {
    const projectTypeStr = Array.isArray(form.project_type) ? form.project_type.join(', ') : form.project_type;
    return {
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email,
      phone: form.phone,
      property_address: form.property_address,
      city: form.city,
      project_type: projectTypeStr,
      message: form.message,
      source: form.source,
      referral_name: form.referral_name,
      assigned_rep: form.assigned_rep,
      owner_occupied: form.owner_occupied,
      follow_up_date: form.follow_up_date || null,
      follow_up_time: form.follow_up_time || null,
      follow_up_type: form.follow_up_type || null,
      appointment_date: form.appointment_date || null,
      appointment_time: form.appointment_time || null,
      budget_range: form.budget_range,
      start_timeframe: form.start_timeframe,
      photo_urls: form.photo_urls,
      status: 'New',
      is_new_intake_lead: true,
      appointment_override: overrideActive,
    };
  };

  const doSubmit = async (forcingCreate = false) => {
    setSubmitting(true);
    setAvailabilityError(null);
    try {
      const payload = buildLeadPayload();
      if (forcingCreate) payload.force_new_lead = true;
      // Admin override requires the Railway JWT; the backend re-verifies it.
      const opts = overrideActive
        ? { adminToken: localStorage.getItem("railway_access_token") || "" }
        : {};
      const data = await submitCapture(payload, opts);
      setSubmittedLead(data?.lead || { first_name: form.first_name, last_name: form.last_name });
      setSubmitted(true);
      if (returnToCRM) setTimeout(() => navigate("/leads"), 2000);
    } catch (error) {
      const data = error?.data || {};
      const code = error?.code || data?.error;
      const backendMsg = data?.message || error.message;
      // Potential duplicate (phone/email match, different name) — show review screen.
      if (code === 'potential_duplicate' && data?.details?.candidates?.length) {
        setDuplicateFound(data.details.candidates.map(c => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone,
          property_address: c.property_address,
          reason: 'Matching phone/email',
          status: 'existing',
        })));
        setSubmitting(false);
        return;
      }
      const isConflict = code === 'conflict' || error?.status === 409;
      const isOverrideForbidden = code === 'override_forbidden' || error?.status === 403;
      if (isOverrideForbidden) {
        setOverrideActive(false);
        setForm(p => ({ ...p, appointment_time: "" }));
      }
      setAvailabilityError(backendMsg || `Error saving lead: ${error.message}`);
      // Slot became unavailable between selection and submit — clear the
      // selected time and refresh availability so the user picks a new slot.
      // No lead is created (the booking transaction rolls back on 409).
      if (isConflict) {
        setForm(p => ({ ...p, appointment_time: "" }));
        if (form.appointment_date) {
          fetchCaptureAvailability({ owner: 'Yaron Drilevich', date: form.appointment_date })
            .then(d => setBlockedSlots(d?.blocked_slots || []))
            .catch(() => {});
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    // Prevent double-click / double-submit
    if (submitting) return;
    if (!validate()) return;
    setConflictOverride(false);
    setAvailabilityError(null);
    await doSubmit(false);
  };

  const reset = () => {
    setSubmitted(false);
    setSubmittedLead(null);
    setErrors({});
    setForm(emptyForm());
    setDuplicateFound(null);
    setConflictOverride(false);
    setAvailabilityError(null);
    setOverrideActive(false);
    setOverrideConfirm(null);
  };

  // ── DUPLICATE SCREEN ───────────────────────────────────────────────────────
  if (duplicateFound) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
          <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-7 h-7 text-amber-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2 text-center">Possible duplicate found</h2>
          <p className="text-slate-600 text-sm mb-4 text-center">This person may already exist in the CRM.</p>
          <div className="bg-slate-50 rounded-lg p-4 mb-6 space-y-3">
            {duplicateFound.map(d => (
              <div key={d.id} className="border-b border-slate-200 last:border-0 pb-3 last:pb-0">
                <div className="text-sm font-semibold text-slate-900">{d.first_name} {d.last_name}</div>
                {d.email && <div className="text-xs text-slate-600 mt-1">📧 {d.email}</div>}
                {d.phone && <div className="text-xs text-slate-600">📞 {d.phone}</div>}
                {d.property_address && <div className="text-xs text-slate-600">📍 {d.property_address}</div>}
                <div className="text-xs text-amber-600 font-medium mt-1">Match: {d.reason}</div>
                <div className="text-xs text-slate-500 mt-0.5">Status: {d.status}</div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 flex-col">
            <button
              onClick={() => { setDuplicateFound(null); doSubmit(true); }}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition-colors text-sm"
            >
              Create Anyway
            </button>
            <button onClick={reset} className="w-full border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold py-3 rounded-xl transition-colors text-sm">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── SUCCESS SCREEN ─────────────────────────────────────────────────────────
  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-5">
            <CheckCircle className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Lead Added to CRM</h2>
          <p className="text-slate-500 text-sm mb-1">Successfully saved to the CRM.</p>
          {submittedLead && (
            <div className="mt-5 bg-slate-50 rounded-xl p-4 text-left space-y-1">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Summary</div>
              <div className="text-sm font-semibold text-slate-800">{submittedLead.first_name} {submittedLead.last_name}</div>
              {submittedLead.phone && <div className="text-xs text-slate-500">📞 {submittedLead.phone}</div>}
              {submittedLead.email && <div className="text-xs text-slate-500">✉️ {submittedLead.email}</div>}
              {submittedLead.project_type && <div className="text-xs text-slate-500">🔨 {submittedLead.project_type}</div>}
              {submittedLead.assigned_rep && <div className="text-xs text-slate-500">👤 Owner: {submittedLead.assigned_rep}</div>}
              {submittedLead.follow_up_date && (
                <div className="text-xs text-amber-700 font-semibold">
                  📅 Follow-up: {submittedLead.follow_up_date}
                  {submittedLead.follow_up_time ? ` at ${fmt12(submittedLead.follow_up_time)}` : ""}
                </div>
              )}
            </div>
          )}
          {returnToCRM ? (
            <div className="mt-6 text-center">
              <p className="text-xs text-slate-500 mb-3">Redirecting you back to Leads…</p>
              <button onClick={() => navigate("/leads")} className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-3 rounded-xl transition-colors text-sm">
                Go to Leads Now
              </button>
            </div>
          ) : (
            <button onClick={reset} className="mt-6 w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition-colors text-sm">
              Add Another Lead
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── MAIN FORM ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-4 py-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <img src="https://media.base44.com/images/public/69f42cee41d29f30bff5c013/6fb826cbc_WhatsAppImage2026-04-30at101207PM.jpg" alt="EC Construction" className="w-10 h-10 object-contain" />
          <div className="flex-1">
            <div className="text-sm font-bold text-slate-900">EC Construction Group</div>
            <div className="text-xs text-amber-600 font-semibold">New Lead Intake Form</div>
          </div>
          {returnToCRM && (
            <button
              onClick={() => navigate("/leads")}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Leads
            </button>
          )}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 pb-16">

        {availabilityError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 font-medium flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {availabilityError}
          </div>
        )}

        {/* ── Step 1: Appointment (date + time first, before contact info) ── */}
        <FormCard icon={<Calendar className="w-4 h-4 text-amber-600" />} title="Step 1: Appointment Date & Time">
          <div className="space-y-3">
            <Field label="Appointment Date *" error={errors.appointment_date}>
              <input
                type="date"
                value={form.appointment_date}
                onChange={e => set("appointment_date", e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className={inputCls(errors.appointment_date)}
              />
            </Field>
            {form.appointment_date && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Appointment Time *</label>
                <CaptureSlotGrid
                  date={form.appointment_date}
                  selectedTime={form.appointment_time}
                  onSelectTime={handleSelectTime}
                  blockedSlots={blockedSlots}
                  loading={slotsLoading}
                  error={slotsError}
                  canOverride={canOverride}
                  overrideSelected={overrideActive}
                />
                {overrideActive && (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-[11px] text-amber-800 font-medium">
                    <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>Override conflict active — this is an explicit double-book at {fmt12(form.appointment_time)} on {form.appointment_date}. Submitting will create the appointment even though the slot is blocked.</span>
                  </div>
                )}
                {errors.appointment_time && <p className="text-xs text-red-600 mt-1">{errors.appointment_time}</p>}
              </div>
            )}
            {form.appointment_date && !slotsLoading && !slotsError && blockedSlots.length > 0 && (
              <p className="text-[11px] text-slate-400">
                {blockedSlots.length} time slot{blockedSlots.length !== 1 ? 's' : ''} unavailable for Yaron Drilevich on this date.
              </p>
            )}
          </div>
        </FormCard>

        {/* ── Contact Info ── */}
        <FormCard icon={<Phone className="w-4 h-4 text-amber-600" />} title="Client Contact Info">
          {errors.phone && <ErrorMsg msg="Phone or email is required" />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First Name *" error={errors.first_name}>
              <input type="text" value={form.first_name} onChange={e => set("first_name", e.target.value)} placeholder="Jane" className={inputCls(errors.first_name)} />
            </Field>
            <Field label="Last Name *" error={errors.last_name}>
              <input type="text" value={form.last_name} onChange={e => set("last_name", e.target.value)} placeholder="Smith" className={inputCls(errors.last_name)} />
            </Field>
            <Field label="Mobile Phone">
              <input type="tel" value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="(310) 555-0000" className={inputCls()} />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="jane@email.com" className={inputCls()} />
            </Field>
          </div>
        </FormCard>

        {/* ── Property Info ── */}
        <FormCard icon={<MapPin className="w-4 h-4 text-amber-600" />} title="Property Information">
          <div className="space-y-3">
            <Field label="Property Address">
              <input type="text" value={form.property_address} onChange={e => set("property_address", e.target.value)} placeholder="123 Main St" className={inputCls()} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <input type="text" value={form.city} onChange={e => set("city", e.target.value)} placeholder="Los Angeles" className={inputCls()} />
              </Field>
              <Field label="ZIP Code">
                <input type="text" value={form.zip_code} onChange={e => set("zip_code", e.target.value)} placeholder="90001" className={inputCls()} />
              </Field>
            </div>
          </div>
        </FormCard>

        {/* ── Project Details ── */}
        <FormCard icon={<Briefcase className="w-4 h-4 text-amber-600" />} title="Project Details">
          <div className="space-y-3">
            <Field label="Project Type *" error={errors.project_type}>
              <div className="grid grid-cols-2 gap-2">
                {projectTypes.map(type => (
                  <label key={type} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs transition-colors ${form.project_type?.includes(type) ? 'border-amber-500 bg-amber-50 text-amber-900' : 'border-slate-200 hover:border-slate-300'}`}>
                    <input type="checkbox" checked={form.project_type?.includes(type) || false} onChange={() => toggleProjectType(type)} className="w-3.5 h-3.5 rounded" />
                    {type}
                  </label>
                ))}
              </div>
              {errors.project_type && <p className="text-xs text-red-600 mt-1">{errors.project_type}</p>}
            </Field>
            <Field label="Desired Start Timeframe">
              <select value={form.start_timeframe} onChange={e => set("start_timeframe", e.target.value)} className={inputCls()}>
                <option value="">Select timeframe</option>
                <option value="ASAP">ASAP</option>
                <option value="Within 30 days">Within 30 days</option>
                <option value="1–3 months">1–3 months</option>
                <option value="3–6 months">3–6 months</option>
                <option value="Just researching">Just researching</option>
              </select>
            </Field>
            <Field label="Estimated Budget">
              <select value={form.budget_range} onChange={e => set("budget_range", e.target.value)} className={inputCls()}>
                <option value="">Select budget range</option>
                <option value="Under $25,000">Under $25,000</option>
                <option value="$25,000–$75,000">$25,000–$75,000</option>
                <option value="$75,000–$150,000">$75,000–$150,000</option>
                <option value="$150,000–$300,000">$150,000–$300,000</option>
                <option value="$300,000+">$300,000+</option>
              </select>
            </Field>
            <Field label="Owner Occupied">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.owner_occupied} onChange={e => set("owner_occupied", e.target.checked)} className="w-4 h-4 rounded" />
                <span className="text-xs text-slate-600">I currently live at this property</span>
              </label>
            </Field>
          </div>
        </FormCard>

        {/* ── Lead Source ── */}
        <FormCard icon={<MapPin className="w-4 h-4 text-amber-600" />} title="Lead Source">
          <div className="space-y-3">
            <Field label="How did you hear about us? *" error={errors.source}>
              <select value={form.source} onChange={e => set("source", e.target.value)} className={inputCls(errors.source)}>
                <option value="">Select source</option>
                {sources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            {form.source === 'Referral' && (
              <Field label="Referral Name">
                <input type="text" value={form.referral_name} onChange={e => set("referral_name", e.target.value)} placeholder="Who referred you?" className={inputCls()} />
              </Field>
            )}
          </div>
        </FormCard>

        {/* ── Contact Owner ── */}
        <FormCard icon={<Phone className="w-4 h-4 text-amber-600" />} title="Who will handle this lead?">
          <Field label="Assign to *" error={errors.assigned_rep}>
            <select value={form.assigned_rep} onChange={e => set("assigned_rep", e.target.value)} className={inputCls(errors.assigned_rep)}>
              <option value="">Select contact owner</option>
              {owners.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        </FormCard>

        {/* ── Follow-up ── */}
        <FormCard icon={<Clock className="w-4 h-4 text-amber-600" />} title="Follow-up (Optional)">
          <div className="space-y-3">
            <Field label="Follow-up Type">
              <select value={form.follow_up_type} onChange={e => set("follow_up_type", e.target.value)} className={inputCls()}>
                <option value="">Select type</option>
                <option value="Phone Call">Phone Call</option>
                <option value="Meeting">Meeting</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Follow-up Date">
                <input type="date" value={form.follow_up_date} onChange={e => set("follow_up_date", e.target.value)} className={inputCls()} />
              </Field>
              <Field label="Follow-up Time">
                <select value={form.follow_up_time} onChange={e => set("follow_up_time", e.target.value)} className={inputCls()}>
                  <option value="">Select time</option>
                  {TIMES.map(t => <option key={t} value={t}>{fmt12(t)}</option>)}
                </select>
              </Field>
            </div>
          </div>
        </FormCard>

        {/* ── Message ── */}
        <FormCard icon={<Briefcase className="w-4 h-4 text-amber-600" />} title="Project Description">
          <Field label="Tell us about your project">
            <textarea value={form.message} onChange={e => set("message", e.target.value)} placeholder="Describe your project, goals, and any specific needs..." rows={4} className="w-full border rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-colors border-slate-200 resize-none" />
          </Field>
        </FormCard>

        {/* ── Photo Upload ── */}
        <FormCard icon={<Upload className="w-4 h-4 text-amber-600" />} title="Upload Photos / Plans (Optional)">
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl py-6 cursor-pointer hover:border-amber-400 transition-colors">
              <Upload className="w-5 h-5 text-slate-400 mb-1" />
              <span className="text-xs text-slate-500 font-medium">{uploading ? "Uploading..." : "Click to upload photos or plans"}</span>
              <input type="file" accept="image/*,application/pdf" multiple onChange={e => { const files = Array.from(e.target.files); files.forEach(uploadFile); }} className="hidden" disabled={uploading} />
            </label>
            {form.photo_urls?.length > 0 && (
              <div className="space-y-2">
                {form.photo_urls.map((url, i) => (
                  <div key={i} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                    {url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                      <img src={url} alt="upload" className="w-10 h-10 object-cover rounded" />
                    ) : (
                      <CheckCircle className="w-5 h-5 text-slate-400" />
                    )}
                    <span className="text-xs text-slate-600 flex-1 truncate">{url.split('/').pop() || `Photo ${i + 1}`}</span>
                    <button type="button" onClick={() => removeFile(i)} className="text-slate-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </FormCard>

        {overrideConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="max-w-sm w-full bg-white rounded-2xl shadow-xl p-6">
              <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
                <ShieldAlert className="w-6 h-6 text-amber-600" />
              </div>
              <h3 className="text-base font-bold text-slate-900 text-center mb-1">Override calendar conflict?</h3>
              <p className="text-xs text-slate-600 text-center mb-1">
                {fmt12(overrideConfirm)} on {form.appointment_date} is blocked.
              </p>
              <p className="text-xs text-slate-500 text-center mb-4">
                This will explicitly double-book the slot. The lead and appointment will still be created normally.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={cancelOverride} className="flex-1 border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold py-2.5 rounded-xl transition-colors text-xs">
                  Cancel
                </button>
                <button type="button" onClick={confirmOverride} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-2.5 rounded-xl transition-colors text-xs">
                  Override conflict
                </button>
              </div>
            </div>
          </div>
        )}

        <button onClick={handleSubmit} disabled={submitting}
          className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-4 rounded-xl text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg flex items-center justify-center gap-2">
          {submitting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Saving to CRM...</>
          ) : overrideActive ? "Submit Override to CRM" : "Submit Lead to CRM"}
        </button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function inputCls(error) {
  return `w-full border rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-colors ${error ? "border-red-400 bg-red-50" : "border-slate-200"}`;
}

function Field({ label, children, error }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{label}</label>
      {children}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

function FormCard({ title, icon, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {title && (
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          {icon}
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

function ErrorMsg({ msg }) {
  return (
    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 text-xs text-red-700">
      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {msg}
    </div>
  );
}