/**
 * Owner Email Resolution Utility
 *
 * Format: first_name (lowercase) + @<company domain>
 *
 * Examples (EC's domain, the default):
 *   "Yaron Drilevich" → "yaron@ecconstructiongroup.com"
 *   "Micky Gad"       → "micky@ecconstructiongroup.com"
 *   "Michelle"        → "michelle@ecconstructiongroup.com"
 *
 * PRODUCTIZATION PHASE 2: `domain` is an optional second param (default
 * EC's domain, so every existing caller/test is unaffected) — mirrors the
 * identical pattern already used backend-side in lib/captureValidation.js,
 * lib/authorization.js and lib/dataAccessRailway.js. Callers that have this
 * installation's real company_settings.company_email/admin_email domain
 * (see crm-frontend/src/components/AppointmentSlotPicker.jsx for the fetch
 * pattern) should pass it explicitly, or this always resolves to EC's
 * domain regardless of installation.
 */
const EC_DOMAIN = 'ecconstructiongroup.com';

export function resolveOwnerEmail(ownerName, domain = EC_DOMAIN) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const firstName = ownerName.trim().split(/\s+/)[0].toLowerCase();
  if (!firstName) return null;
  return `${firstName}@${domain}`;
}

export function validateOwnerEmail(email, domain = EC_DOMAIN) {
  if (!email) return { valid: false, reason: 'No email' };
  const emailRegex = new RegExp(`^[a-zA-Z]+@${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  if (!emailRegex.test(email)) return { valid: false, reason: `Invalid format (expected firstname@${domain})` };
  return { valid: true };
}