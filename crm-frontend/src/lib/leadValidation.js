/**
 * Lead Quality Validation
 * 
 * A lead is considered "complete" (valid for active pipeline) if it has:
 * - (Name) AND (Phone OR Email)
 * - OR Phone + Email (even without name)
 * - OR Phone alone
 * 
 * Invalid leads have:
 * - Just name
 * - Just email
 * - Missing all contact info
 */

export const isCompleteLeads = (lead) => {
  const hasFirstName = lead.first_name && lead.first_name.trim() !== '';
  const hasLastName = lead.last_name && lead.last_name.trim() !== '';
  const hasName = hasFirstName || hasLastName;
  
  const hasPhone = lead.phone && lead.phone.trim() !== '';
  const hasEmail = lead.email && lead.email.trim() !== '';

  // Valid combinations:
  // 1. Has name AND at least phone or email
  if (hasName && (hasPhone || hasEmail)) return true;
  
  // 2. Has both phone and email (even without name)
  if (hasPhone && hasEmail) return true;
  
  // 3. Has phone alone
  if (hasPhone) return true;

  // Everything else is incomplete
  return false;
};

export const getLeadQualityScore = (lead) => {
  let score = 0;
  
  if (lead.first_name && lead.first_name.trim() !== '') score += 1;
  if (lead.last_name && lead.last_name.trim() !== '') score += 1;
  if (lead.phone && lead.phone.trim() !== '') score += 2; // Phone is high value
  if (lead.email && lead.email.trim() !== '') score += 2; // Email is high value
  if (lead.project_type) score += 1;
  if (lead.estimated_value) score += 1;
  
  return score;
};