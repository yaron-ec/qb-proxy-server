/**
 * Format utilities to prevent zero/null from displaying
 */

// Display value safely — never show "0" or null literally
export const safeDisplay = (value) => {
  if (value === null || value === undefined || value === '' || value === '0' || value === 0) {
    return '—';
  }
  return value;
};

// Format money safely — never show "$0"
export const fmtMoney = (v) => {
  if (v === null || v === undefined || v === 0) {
    return '—';
  }
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

// Format date safely
export const fmtDate = (isoStr) => {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
};

// Format US or international phone numbers for display only (does not change stored value)
// Global standard: +1 (XXX) XXX-XXXX for US numbers
export const formatPhone = (raw) => {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  // US: 11 digits starting with 1 (e.g. 18184269815)
  if (digits.length === 11 && digits[0] === '1') {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // US: 10 digits — assume US, prepend +1
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Already formatted or international — return as-is
  return raw;
};

// Preserved abbreviations — always keep these uppercase
const ABBREVIATIONS = new Set(['ADU', 'HVAC', 'HOA', 'USA', 'CA', 'LA', 'LLC', 'AC', 'HVAC']);

/**
 * Convert a string to Title Case — always normalizes.
 * - Preserves known abbreviations (ADU, HVAC, HOA, etc.)
 * - Handles hyphenated names (Smith-Johnson)
 * - Handles apostrophe names (O'Connor)
 * - Fixes ALL CAPS, all lowercase, and mixed-case (jOE aLBARRAN → Joe Albarran)
 */
export const toTitleCase = (str) => {
  if (!str) return str;
  const s = String(str).trim();
  if (!s) return s;

  const capitalizeWord = (word) => {
    if (!word) return word;
    // Check abbreviation list first
    if (ABBREVIATIONS.has(word.toUpperCase())) return word.toUpperCase();
    // Handle apostrophes: O'Connor
    if (word.includes("'")) {
      return word.split("'").map(part =>
        part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
      ).join("'");
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  };

  // Handle hyphenated words: Smith-Johnson
  return s.split(' ').map(word => {
    if (word.includes('-')) {
      return word.split('-').map(capitalizeWord).join('-');
    }
    return capitalizeWord(word);
  }).join(' ');
};

// Format datetime safely
export const fmtDateTime = (isoStr) => {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  });
};