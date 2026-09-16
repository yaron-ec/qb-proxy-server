/**
 * ContactInfoEditor — ONE coherent Contact card for Lead Detail.
 *
 * Previously this rendered eight independent editable rows (First Name,
 * Last Name, Phone, Email, Street, City, State, ZIP), each with its own
 * pencil icon — a wall of identical controls with no sense that they're
 * one person's contact record. Redesigned into a single card with ONE
 * "Edit" action that puts every contact field into one coherent edit
 * state, saved with a single "Save Changes" call.
 *
 * View mode: name, phone (Call/SMS), email (Email), and address (with its
 * verification state — see lib/addressActions.js — and Directions/View
 * Property actions) are presented as read text with contextual quick
 * actions, not a field-by-field edit form.
 */
import { useState } from 'react';
import { Phone, Mail, MapPin, Pencil, RefreshCw, AlertCircle, CheckCircle2, AlertTriangle, Copy, Navigation, Eye, X } from 'lucide-react';
import { leads as railwayLeads } from '@/api/railway';
import { formatPhone, toTitleCase } from '@/lib/formatters';
import { getFullAddress, getDirectionsUrl, getPropertyViewUrl } from '@/lib/addressActions';
import { useToast } from '@/components/ui/use-toast';
import TruncatedTooltip from '@/components/TruncatedTooltip';
import Tip from '@/components/ui/Tip';
import ContactActions from '@/components/ContactActions';

// ── Phone normalization (matches CRM display logic) ──────────────────────────
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+1${digits.slice(1)}`;
  return raw.trim();
}

function isEmailValid(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isPhoneValid(phone) {
  if (!phone) return true;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits[0] === '1');
}

function CopyBtn({ value, label }) {
  const { toast } = useToast();
  if (!value) return null;
  return (
    <Tip label={`Copy ${label}`}>
      <button
        onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(value).then(() => toast({ title: `${label} copied`, duration: 1500 })); }}
        aria-label={`Copy ${label}`}
        className="flex items-center justify-center w-6 h-6 rounded hover:bg-slate-100 text-slate-300 hover:text-slate-600 transition-colors flex-shrink-0"
      >
        <Copy className="w-3 h-3" />
      </button>
    </Tip>
  );
}

// ── Address verification badge (reads status computed by the ONE canonical
// backend pipeline — lib/addressPipeline.js — never re-derived here) ────────
function AddressStatusBadge({ lead }) {
  const status = lead.property_geocode_status;
  if (!lead.property_address) return null;
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
        <CheckCircle2 className="w-3 h-3" /> Verified address
      </span>
    );
  }
  if (status === 'needs_review') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
        <AlertTriangle className="w-3 h-3" /> Address needs review
      </span>
    );
  }
  // 'error' | 'not_found' | 'pending' | null — no confident claim either way.
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5">
      Not verified
    </span>
  );
}

function AddressReviewBanner({ lead, onLeadUpdate }) {
  const { toast } = useToast();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);
  if (lead.property_geocode_status !== 'needs_review' || !lead.verified_property_address) return null;

  const useSuggested = async () => {
    setApplying(true);
    setError(null);
    try {
      // Re-run through the SAME address pipeline any manual edit goes
      // through (PUT /:id re-normalizes + re-geocodes on property_address
      // change) — never a separate "accept" write path. Clearing city/
      // state/zip lets Google's own formatted string be the sole geocode
      // input, so a well-formed Google address round-trips to a confident
      // match and the pipeline re-derives city/state/zip itself.
      const leadId = lead.railway_id || lead.id;
      const result = await railwayLeads.update(leadId, {
        property_address: lead.verified_property_address,
        city: '', state: '', zip: '',
      });
      if (result?.lead) {
        onLeadUpdate({ ...lead, ...result.lead });
        toast({ title: 'Address updated', duration: 2000 });
      }
    } catch (e) {
      setError(e?.message || 'Could not apply the suggested address.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-1.5 text-[11px] bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 space-y-1.5">
      <p className="text-amber-800">
        <span className="font-semibold">Suggested:</span> {lead.verified_property_address}
      </p>
      {error && <p className="text-red-600">{error}</p>}
      <button
        onClick={useSuggested}
        disabled={applying}
        className="text-[11px] font-semibold text-amber-800 underline hover:text-amber-900 disabled:opacity-50"
      >
        {applying ? 'Applying…' : 'Use suggested address'}
      </button>
    </div>
  );
}

function AddressMapActions({ lead }) {
  const directionsUrl = getDirectionsUrl(lead);
  const propertyUrl = getPropertyViewUrl(lead);
  if (!directionsUrl && !propertyUrl) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      {/* Location/navigation actions are the canonical indigo family — see
          components/ContactActions.jsx's semantic color doc — never the
          same color as Call/SMS/Email. */}
      {directionsUrl && (
        <a href={directionsUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md px-2 py-1 transition-colors">
          <Navigation className="w-3 h-3" /> Directions
        </a>
      )}
      {propertyUrl && (
        <a href={propertyUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50/50 hover:bg-indigo-100 border border-indigo-200 rounded-md px-2 py-1 transition-colors">
          <Eye className="w-3 h-3" /> View Property
        </a>
      )}
    </div>
  );
}

// ── Edit form (all fields at once) ──────────────────────────────────────────
function ContactEditForm({ lead, onLeadUpdate, onDone }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    phone: lead.phone || '',
    email: lead.email || '',
    property_address: lead.property_address || '',
    city: lead.city || '',
    state: lead.state || '',
    zip: lead.zip || '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }));

  const handleSave = async () => {
    const trimmed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    if (!trimmed.first_name) return setError('First name is required');
    if (!trimmed.last_name) return setError('Last name is required');
    if (trimmed.email && !isEmailValid(trimmed.email)) return setError('Invalid email format');
    if (trimmed.phone && !isPhoneValid(trimmed.phone)) return setError('Use a valid US phone (10 digits)');

    setSaving(true);
    setError(null);
    try {
      const leadId = lead.railway_id || lead.id;
      const result = await railwayLeads.update(leadId, trimmed);
      if (result?.lead) {
        onLeadUpdate({ ...lead, ...result.lead });
      }
      toast({ title: 'Contact info saved.', duration: 2000 });
      onDone();
    } catch (e) {
      const status = e?.status;
      const data = e?.data;
      if (status === 409 && data?.conflict) {
        setError(`${data.message || 'Duplicate detected'} (Lead: ${data.conflict.name})`);
      } else if (status === 400 && (data?.error === 'invalid_email' || data?.error === 'invalid_phone')) {
        setError(data.message || 'Invalid value');
      } else {
        setError(e?.message || 'Save failed. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500";

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="crm-label">First Name</label>
          <input className={inputClass} value={form.first_name} onChange={set('first_name')} placeholder="First name" />
        </div>
        <div>
          <label className="crm-label">Last Name</label>
          <input className={inputClass} value={form.last_name} onChange={set('last_name')} placeholder="Last name" />
        </div>
        <div>
          <label className="crm-label">Phone</label>
          <input className={inputClass} type="tel" value={form.phone} onChange={set('phone')} placeholder="(310) 555-0000" />
        </div>
        <div>
          <label className="crm-label">Email</label>
          <input className={inputClass} type="email" value={form.email} onChange={set('email')} placeholder="email@example.com" />
        </div>
        <div className="col-span-2">
          <label className="crm-label">Street Address</label>
          <input className={inputClass} value={form.property_address} onChange={set('property_address')} placeholder="123 Main St" />
        </div>
        <div>
          <label className="crm-label">City</label>
          <input className={inputClass} value={form.city} onChange={set('city')} placeholder="Los Angeles" />
        </div>
        <div>
          <label className="crm-label">State</label>
          <input className={inputClass} value={form.state} onChange={set('state')} placeholder="CA" />
        </div>
        <div>
          <label className="crm-label">ZIP</label>
          <input className={inputClass} value={form.zip} onChange={set('zip')} placeholder="90001" />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-1.5">
        <button onClick={handleSave} disabled={saving}
          className="flex-1 px-2 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
          {saving && <RefreshCw className="w-3 h-3 animate-spin" />}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button onClick={onDone} disabled={saving}
          className="flex-1 px-2 py-1.5 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── View mode ────────────────────────────────────────────────────────────
function ContactView({ lead }) {
  const fullAddress = getFullAddress(lead);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <Phone className="w-3.5 h-3.5 text-green-600 flex-shrink-0 mt-[3px]" />
        <div className="flex-1 min-w-0">
          <p className="crm-label">Phone</p>
          <div className="flex items-center justify-between gap-2 min-w-0">
            {lead.phone
              ? <TruncatedTooltip text={formatPhone(lead.phone)} className="crm-value" />
              : <span className="crm-empty">—</span>}
            <CopyBtn value={lead.phone} label="Phone" />
          </div>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-[3px]" />
        <div className="flex-1 min-w-0">
          <p className="crm-label">Email</p>
          <div className="flex items-center justify-between gap-2 min-w-0">
            {lead.email
              ? <TruncatedTooltip text={lead.email} className="crm-value" />
              : <span className="crm-empty">—</span>}
            <CopyBtn value={lead.email} label="Email" />
          </div>
        </div>
      </div>

      {/* Same Call/SMS/Email component used on Active Leads, Dashboard's
          Today's Work, and My Day — 'md' size matches its own "detail
          panels" variant. */}
      {(lead.phone || lead.email) && (
        <div className="pl-6">
          <ContactActions phone={lead.phone} email={lead.email} size="md" labels />
        </div>
      )}

      <div className="flex items-start gap-3">
        <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-[3px]" />
        <div className="flex-1 min-w-0">
          <p className="crm-label">Address</p>
          <div className="flex items-center justify-between gap-2 min-w-0">
            {fullAddress
              ? <TruncatedTooltip text={toTitleCase(fullAddress)} className="crm-value" />
              : <span className="crm-empty">—</span>}
            <CopyBtn value={fullAddress} label="Address" />
          </div>
          {fullAddress && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <AddressStatusBadge lead={lead} />
            </div>
          )}
          {fullAddress && <AddressMapActions lead={lead} />}
        </div>
      </div>
    </div>
  );
}

export default function ContactInfoEditor({ lead, onLeadUpdate }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-slate-900">
          {toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}
        </p>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-amber-600 transition-colors"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        )}
        {editing && (
          <button
            onClick={() => setEditing(false)}
            aria-label="Close edit"
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-100 text-slate-400"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {editing ? (
        <ContactEditForm lead={lead} onLeadUpdate={onLeadUpdate} onDone={() => setEditing(false)} />
      ) : (
        <>
          <ContactView lead={lead} />
          <AddressReviewBanner lead={lead} onLeadUpdate={onLeadUpdate} />
        </>
      )}
    </div>
  );
}
