/**
 * Owner to Email Address Mapping
 * Maps lead owner names to their actual Gmail addresses
 */

export const OWNER_EMAIL_MAP = {
  "Yaron": "yaron@ecconstructiongroup.com",
  "Yaron Drilevich": "yaron@ecconstructiongroup.com",
  "Mickey": "micky@ecconstructiongroup.com",
  "Mickey Gad": "micky@ecconstructiongroup.com",
  "Micky": "micky@ecconstructiongroup.com",
  "Micky Gad": "micky@ecconstructiongroup.com",
  "Victoria": "victoria@ecconstructiongroup.com",
};

export function getOwnerEmail(ownerName) {
  if (!ownerName) return null;
  const normalized = String(ownerName).trim();
  return OWNER_EMAIL_MAP[normalized] || null;
}