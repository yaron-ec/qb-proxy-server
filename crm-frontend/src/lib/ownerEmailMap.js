/**
 * Owner Email Resolution Utility
 * 
 * Format: first_name (lowercase) + @ecconstructiongroup.com
 * 
 * Examples:
 *   "Yaron Drilevich" → "yaron@ecconstructiongroup.com"
 *   "Micky Gad"       → "micky@ecconstructiongroup.com"
 *   "Michelle"        → "michelle@ecconstructiongroup.com"
 */

export function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const firstName = ownerName.trim().split(/\s+/)[0].toLowerCase();
  if (!firstName) return null;
  return `${firstName}@ecconstructiongroup.com`;
}

export function validateOwnerEmail(email) {
  if (!email) return { valid: false, reason: 'No email' };
  const emailRegex = /^[a-zA-Z]+@ecconstructiongroup\.com$/;
  if (!emailRegex.test(email)) return { valid: false, reason: 'Invalid format (expected firstname@ecconstructiongroup.com)' };
  return { valid: true };
}