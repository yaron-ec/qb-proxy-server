/**
 * Duplicate Detection & Normalization Utilities
 * 
 * Provides functions to:
 * - Normalize phone numbers and emails
 * - Detect potential duplicates by multiple criteria
 * - Find best match for a lead
 */

/**
 * Normalize phone number to digits only
 * Handles: +1-310-251-7454, (310) 251-7454, 3102517454, etc.
 */
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  // Remove leading 1 if 11 digits (US)
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
}

/**
 * Normalize email to lowercase
 */
export function normalizeEmail(email) {
  if (!email) return null;
  return String(email).toLowerCase().trim();
}

/**
 * Normalize name (title case, trim)
 */
export function normalizeName(name) {
  if (!name) return null;
  return String(name).trim().toLowerCase();
}

/**
 * Find potential duplicates in lead list
 * Returns array of { leadA, leadB, matchType, confidence }
 */
export function findPotentialDuplicates(leads) {
  const duplicates = [];
  const seen = new Set();

  for (let i = 0; i < leads.length; i++) {
    for (let j = i + 1; j < leads.length; j++) {
      const leadA = leads[i];
      const leadB = leads[j];
      const pairKey = [leadA.id, leadB.id].sort().join('-');
      
      if (seen.has(pairKey)) continue;

      const match = detectDuplicate(leadA, leadB);
      if (match) {
        seen.add(pairKey);
        duplicates.push({
          leadA,
          leadB,
          matchType: match.type,
          confidence: match.confidence,
        });
      }
    }
  }

  return duplicates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Detect if two leads are likely duplicates
 * Returns { type, confidence } or null
 */
export function detectDuplicate(leadA, leadB) {
  if (!leadA || !leadB || leadA.id === leadB.id) return null;

  // Ignore if either is marked as "Contact" or non-Lead
  if (leadA.record_type === 'Contact' || leadB.record_type === 'Contact') return null;
  if (leadA.is_contact || leadB.is_contact) return null;

  // 1. Phone match (highest confidence)
  const phoneA = normalizePhone(leadA.phone);
  const phoneB = normalizePhone(leadB.phone);
  if (phoneA && phoneB && phoneA === phoneB) {
    return { type: 'phone_match', confidence: 0.99 };
  }

  // 2. Email match (high confidence)
  const emailA = normalizeEmail(leadA.email);
  const emailB = normalizeEmail(leadB.email);
  if (emailA && emailB && emailA === emailB) {
    return { type: 'email_match', confidence: 0.98 };
  }

  // 3. Name + Phone match
  const nameAFull = `${normalizeName(leadA.first_name)} ${normalizeName(leadA.last_name)}`;
  const nameBFull = `${normalizeName(leadB.first_name)} ${normalizeName(leadB.last_name)}`;
  if (nameAFull === nameBFull && phoneA && phoneB && phoneA === phoneB) {
    return { type: 'name_phone_match', confidence: 0.95 };
  }

  // 4. Name + Email match
  if (nameAFull === nameBFull && emailA && emailB && emailA === emailB) {
    return { type: 'name_email_match', confidence: 0.94 };
  }

  // 5. Name + City match (lower confidence)
  const cityA = normalizeName(leadA.city);
  const cityB = normalizeName(leadB.city);
  if (nameAFull === nameBFull && cityA && cityB && cityA === cityB) {
    return { type: 'name_city_match', confidence: 0.75 };
  }

  // 6. Name + Address match (lower confidence)
  const addrA = normalizeName(leadA.property_address);
  const addrB = normalizeName(leadB.property_address);
  if (nameAFull === nameBFull && addrA && addrB && addrA === addrB) {
    return { type: 'name_address_match', confidence: 0.80 };
  }

  return null;
}

/**
 * Find best matching lead for a new lead being created
 * Returns matching lead or null
 */
export function findBestMatch(newLead, existingLeads) {
  let bestMatch = null;
  let bestConfidence = 0;

  for (const existing of existingLeads) {
    const match = detectDuplicate(newLead, existing);
    if (match && match.confidence > bestConfidence) {
      bestMatch = existing;
      bestConfidence = match.confidence;
    }
  }

  // Only return match if confidence > 0.75 (exclude low-confidence matches)
  return bestConfidence > 0.75 ? bestMatch : null;
}