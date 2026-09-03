/**
 * Format utilities to prevent zero/null from displaying
 */

// Display value safely — never show "0" or null literally
export const safeDisplay = (value) => {
  if (value === null || value === undefined || value === '' || value === '0' || value === 0) {
    return '\u2014';
  }
  return value;
};

// Format money safely — never show "$0"
export const fmtMoney = (v) => {
  if (v === null || v === undefined || v === 0) {
    return '\u2014';
  }
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

// Format date safely
export const fmtDate = (isoStr) => {
  if (!isoStr) return '\u2014';
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
 * - Fixes ALL CAPS, all lowercase, and mixed-case (jOE aLBARRAN â Joe Albarran)
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

// Fix common UTF-8 mojibake patterns (bytes interpreted as Latin-1)
export const fixMojibake = (str) => {
  if (!str || typeof str !== 'string') return str;
  return str
    // Windows-1252 mojibake (with \u20ac euro sign)
    .replace(/\u00e2\u20ac\u201c/g, '\u2013')   // \u00e2\u20ac\u201c -> en-dash
    .replace(/\u00e2\u20ac\u201d/g, '\u2014')   // \u00e2\u20ac\u201d -> em-dash
    .replace(/\u00e2\u20ac\u2122/g, '\u2019')   // \u00e2\u20ac\u2122 -> rsquo
    .replace(/\u00e2\u20ac\u0153/g, '\u201c')   // \u00e2\u20ac\u0153 -> ldquo
    .replace(/\u00e2\u20ac\u009d/g, '\u201d')   // \u00e2\u20ac\u009d -> rdquo
    .replace(/\u00e2\u20ac\u00a0/g, '\u00a0')   // \u00e2\u20ac\u00a0 -> nbsp
    // Latin-1 mojibake (with \u0080 control char — common in Postgres/Node encoding issues)
    .replace(/\u00e2\u0080\u0093/g, '\u2013')   // \u00e2\u0080\u0093 -> en-dash
    .replace(/\u00e2\u0080\u0094/g, '\u2014')   // \u00e2\u0080\u0094 -> em-dash
    .replace(/\u00e2\u0080\u0099/g, '\u2019')   // \u00e2\u0080\u0099 -> rsquo
    .replace(/\u00e2\u0080\u009c/g, '\u201c')   // \u00e2\u0080\u009c -> ldquo
    .replace(/\u00e2\u0080\u009d/g, '\u201d')   // \u00e2\u0080\u009d -> rdquo
    .replace(/\u00e2\u0080\u00a6/g, '\u2026')   // \u00e2\u0080\u00a6 -> ellipsis
    .replace(/\u00e2\u0080\u00a2/g, '\u2022')   // \u00e2\u0080\u00a2 -> bullet
    // Double-encoded UTF-8 (\u00c3\u00a2 = double-encoded \u00e2)
    .replace(/\u00c3\u00a2\u00c2\u20ac\u00c2\u201c/g, '\u2013')
    .replace(/\u00c3\u00a2\u00c2\u20ac\u00c2\u201d/g, '\u2014')
    .replace(/\u00c3\u00a2\u00c2\u20ac\u00c2\u2122/g, '\u2019');
};


// Fix field value — applies mojibake repair and handles null/undefined
// Used for all displayed DB values that may have been corrupted during import/sync
export const fixField = (value) => {
  if (value === null || value === undefined) return value;
  const s = String(value);
  if (!s) return s;
  return fixMojibake(s);
};

// Format project_type for display — handles JSON arrays, mojibake, and comma-separated values
export const formatProjectType = (raw) => {
  if (!raw) return raw;
  let s = String(raw).trim();
  if (!s) return s;
  s = fixMojibake(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter(Boolean).join(', ');
    } catch { /* not valid JSON */ }
  }
  return s;
};

// Format datetime safely
export const fmtDateTime = (isoStr) => {
  if (!isoStr) return '\u2014';
  return new Date(isoStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  });
};