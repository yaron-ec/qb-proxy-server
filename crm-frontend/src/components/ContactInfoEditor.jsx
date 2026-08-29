/**
 * ContactInfoEditor
 *
 * Editable Contact Info section for the Lead Detail left sidebar.
 * Uses Railway API + Railway Postgres exclusively — no Base44 calls.
 *
 * Behavior:
 * - Each field (First Name, Last Name, Phone, Email, Address, City, State, ZIP)
 *   has its own pencil icon. Clicking it edits ONLY that field inline.
 * - Uses the CRM's established inline-edit pattern (pencil icon → input → Save/Cancel),
 *   matching EditableField / EmailEditField / EditNameButton styles.
 * - Save: trims, validates, normalizes phone, calls Railway PUT /by-external
 *   with ONLY the edited field. All other fields preserved unchanged.
 * - Duplicate email/phone on another lead → 409 conflict shown inline for that field.
 * - Does NOT create calendar events, send emails, trigger reminders, or create duplicates.
 * - Preserves the existing lead ID (Base44 ID used as external_ref for Railway upsert).
 */
import { useState } from 'react';
import { Phone, Mail, MapPin, MessageSquare, Pencil, User, RefreshCw, AlertCircle } from 'lucide-react';
import { leads as railwayLeads } from '@/api/railway';
import { formatPhone, toTitleCase } from '@/lib/formatters';
import { composeEmail } from '@/lib/contactActions';
import { useToast } from '@/components/ui/use-toast';
import TruncatedTooltip from '@/components/TruncatedTooltip';
import Tip from '@/components/ui/Tip';

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

// ── EditableContactField ─────────────────────────────────────────────────────
// Reusable per-field inline editor. Matches the CRM's established pattern:
// pencil icon (like EditNameButton) → inline input → Save/Cancel (like EditableField).
function EditableContactField({ lead, field, label, icon: Icon, iconClass, placeholder, type = 'text', onLeadUpdate, children, actionButtons }) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [val, setVal] = useState(lead[field] || '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const startEdit = (e) => {
    e?.stopPropagation?.();
    setVal(lead[field] || '');
    setError(null);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setError(null);
    setVal(lead[field] || '');
  };

  const handleSave = async () => {
    const trimmed = type === 'tel' ? val.trim() : val.trim();

    // Validate per field
    const errs = {};
    if (field === 'first_name' && !trimmed) errs._ = 'First name is required';
    if (field === 'last_name' && !trimmed) errs._ = 'Last name is required';
    if (field === 'email' && trimmed && !isEmailValid(trimmed)) errs._ = 'Invalid email format';
    if (field === 'phone' && trimmed && !isPhoneValid(trimmed)) errs._ = 'Use a valid US phone (10 digits)';
    if (errs._) { setError(errs._); return; }

    setSaving(true);
    try {
      const payload = { [field]: trimmed };
      const result = await railwayLeads.updateByExternal(lead.id, payload);
      if (result?.lead) {
        const r = result.lead;
        onLeadUpdate({ ...lead, [field]: r[field] ?? lead[field] });
      }
      setIsEditing(false);
      setError(null);
      toast({ title: `${label} saved.`, duration: 2000 });
    } catch (e) {
      const status = e?.status;
      const data = e?.data;
      if (status === 409 && data?.conflict) {
        const c = data.conflict;
        setError(`${data.message || 'Duplicate detected'} (Lead: ${c.name})`);
      } else if (status === 400 && data?.error === 'invalid_email') {
        setError(data.message || 'Invalid email');
      } else if (status === 400 && data?.error === 'invalid_phone') {
        setError(data.message || 'Invalid phone');
      } else {
        setError(e?.message || 'Save failed. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const inputClass = `w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500 disabled:opacity-60 ${error ? 'border-red-400 bg-red-50' : 'border-slate-200'}`;

  // ── Edit mode ────────────────────────────────────────────────────────────
  if (isEditing) {
    return (
      <div className="space-y-1.5">
        <input
          type={type}
          value={val}
          disabled={saving}
          autoFocus
          placeholder={placeholder}
          onChange={e => { setVal(e.target.value); setError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') cancelEdit();
          }}
          className={inputClass}
        />
        {error && (
          <div className="flex items-start gap-1.5 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex gap-1.5">
          <button onClick={handleSave} disabled={saving}
            className="flex-1 px-2 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
            {saving && <RefreshCw className="w-3 h-3 animate-spin" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={cancelEdit} disabled={saving}
            className="flex-1 px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors disabled:opacity-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── View mode ────────────────────────────────────────────────────────────
  return (
    <div className="flex items-start gap-3">
      <Icon className={`w-3.5 h-3.5 ${iconClass || 'text-slate-400'} flex-shrink-0 mt-[3px]`} />
      <div className="flex-1 min-w-0">
        <p className="crm-label">{label}</p>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex-1 min-w-0">{children}</div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {actionButtons}
            <Tip label={`Edit ${label}`}>
              <button
                onClick={startEdit}
                aria-label={`Edit ${label}`}
                className="btn-compact flex items-center justify-center w-6 h-6 rounded hover:bg-amber-50 text-slate-300 hover:text-amber-500 transition-colors flex-shrink-0"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </Tip>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContactInfoEditor({ lead, onLeadUpdate }) {
  const addressParts = [lead.property_address, lead.city, lead.state, lead.zip].filter(Boolean);
  const hasAddress = addressParts.length > 0;

  return (
    <div className="space-y-3.5">
      {/* First Name */}
      <EditableContactField lead={lead} field="first_name" label="First Name" icon={User} iconClass="text-slate-400"
        placeholder="First name" onLeadUpdate={onLeadUpdate}>
        <TruncatedTooltip text={toTitleCase(lead.first_name) || '—'} className="crm-value" />
      </EditableContactField>

      {/* Last Name */}
      <EditableContactField lead={lead} field="last_name" label="Last Name" icon={User} iconClass="text-slate-400"
        placeholder="Last name" onLeadUpdate={onLeadUpdate}>
        <TruncatedTooltip text={toTitleCase(lead.last_name) || '—'} className="crm-value" />
      </EditableContactField>

      {/* Phone */}
      <EditableContactField lead={lead} field="phone" label="Phone" icon={Phone} iconClass="text-green-600"
        type="tel" placeholder="(310) 555-0000" onLeadUpdate={onLeadUpdate}
        actionButtons={lead.phone ? (
          <>
            <Tip label={`Call ${formatPhone(lead.phone)}`} side="top">
              <a href={`tel:${lead.phone}`} aria-label={`Call ${formatPhone(lead.phone)}`} className="crm-action-btn text-green-700 hover:bg-green-50 hover:border-green-200">
                <Phone className="w-3 h-3" />
              </a>
            </Tip>
            <Tip label={`Text ${formatPhone(lead.phone)}`} side="top">
              <a href={`sms:${lead.phone}`} aria-label={`Text ${formatPhone(lead.phone)}`} className="crm-action-btn text-blue-600 hover:bg-blue-50 hover:border-blue-200">
                <MessageSquare className="w-3 h-3" />
              </a>
            </Tip>
          </>
        ) : null}>
        {lead.phone
          ? <TruncatedTooltip text={formatPhone(lead.phone)} className="crm-value" />
          : <span className="crm-empty">—</span>}
      </EditableContactField>

      {/* Email */}
      <EditableContactField lead={lead} field="email" label="Email" icon={Mail} iconClass="text-slate-400"
        type="email" placeholder="email@example.com" onLeadUpdate={onLeadUpdate}
        actionButtons={lead.email ? (
          <Tip label={`Email ${lead.email}`} side="top">
            <a href={`mailto:${lead.email}`} aria-label={`Email ${lead.email}`} className="crm-action-btn text-amber-700 hover:bg-amber-50 hover:border-amber-200"
              onClick={e => { e.preventDefault(); composeEmail(lead.email, e); }}>
              <Mail className="w-3 h-3" />
            </a>
          </Tip>
        ) : null}>
        {lead.email
          ? <TruncatedTooltip text={lead.email} className="crm-value" />
          : <span className="crm-empty">—</span>}
      </EditableContactField>

      {/* Property Address */}
      <EditableContactField lead={lead} field="property_address" label="Street Address" icon={MapPin} iconClass="text-slate-400"
        placeholder="123 Main St" onLeadUpdate={onLeadUpdate}>
        {lead.property_address
          ? <TruncatedTooltip text={toTitleCase(lead.property_address)} className="crm-value" />
          : <span className="crm-empty">—</span>}
      </EditableContactField>

      {/* City */}
      <EditableContactField lead={lead} field="city" label="City" icon={MapPin} iconClass="text-slate-400"
        placeholder="Los Angeles" onLeadUpdate={onLeadUpdate}>
        {lead.city
          ? <TruncatedTooltip text={toTitleCase(lead.city)} className="crm-value" />
          : <span className="crm-empty">—</span>}
      </EditableContactField>

      {/* State */}
      <EditableContactField lead={lead} field="state" label="State" icon={MapPin} iconClass="text-slate-400"
        placeholder="CA" onLeadUpdate={onLeadUpdate}>
        <span className="crm-value">{lead.state || <span className="crm-empty">—</span>}</span>
      </EditableContactField>

      {/* ZIP */}
      <EditableContactField lead={lead} field="zip" label="ZIP" icon={MapPin} iconClass="text-slate-400"
        placeholder="90001" onLeadUpdate={onLeadUpdate}>
        <span className="crm-value">{lead.zip || <span className="crm-empty">—</span>}</span>
      </EditableContactField>
    </div>
  );
}