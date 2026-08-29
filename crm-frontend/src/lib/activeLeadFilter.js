/**
 * Shared Active Lead Filter Logic
 * 
 * Used by both Dashboard and Leads page to ensure consistent active lead counting.
 * This prevents count mismatches between different parts of the app.
 */

// Status values that mean a lead is no longer "active"
export const INACTIVE_STATUSES = new Set([
  'Sold',
  'Lost',
  'DNQ',
  'Closed Lost',
  'Closed',
  'Won',
  'Dead',
  'Duplicate',
  'Archived',
  'Cancelled',
]);

/**
 * Check if a lead is an "active" sales lead
 * 
 * Criteria:
 * 1. Not in INACTIVE_STATUSES
 * 2. record_type !== 'Contact' (contact-only records excluded)
 * 3. Not an email-only name (must have at least a first name and last name)
 * 4. first_name and last_name don't contain 'unknown'
 * 
 * @param {Object} lead - Lead object with status, record_type, first_name, last_name
 * @returns {boolean} True if lead is an active sales lead
 */
export function isActiveSalesLead(lead) {
  // 1. Status check — exclude inactive statuses
  if (INACTIVE_STATUSES.has(lead.status)) {
    return false;
  }

  // 2. Record type check — exclude Contact-only records
  if (lead.record_type === 'Contact' || lead.is_contact === true) {
    return false;
  }

  // 3. Name validity check — exclude email-only records
  const fullName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fullName);
  if (looksLikeEmail) {
    return false;
  }

  // 4. Exclude unknown names
  if (lead.first_name?.toLowerCase().includes('unknown')) {
    return false;
  }
  if (lead.last_name?.toLowerCase().includes('unknown')) {
    return false;
  }

  return true;
}

/**
 * Filter an array of leads to only active sales leads
 * 
 * @param {Array} leads - Array of lead objects
 * @returns {Array} Filtered array of active leads
 */
export function filterActiveSalesLeads(leads) {
  return leads.filter(isActiveSalesLead);
}

/**
 * Count active sales leads in an array
 * 
 * @param {Array} leads - Array of lead objects
 * @returns {number} Count of active leads
 */
export function countActiveSalesLeads(leads) {
  return filterActiveSalesLeads(leads).length;
}