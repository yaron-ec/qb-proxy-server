/**
 * Owner display color resolution (Daily Map / My Day pins and badges).
 *
 * PRODUCTIZATION: KNOWN_OWNER_COLORS below is EC's own hand-picked roster —
 * cosmetic bootstrap data, not universal product logic (classification: EC
 * BOOTSTRAP DATA). Previously this lookup lived inline in pages/DailyMap.jsx
 * as a plain object, and every unrecognized name (which is EVERY rep at any
 * installation other than EC) fell back to the same flat gray "Unassigned"
 * color — a real Company #2 defect: a new installation's reps would never
 * get distinct Daily Map colors no matter how many real, active reps they
 * have.
 *
 * getOwnerColor(name) below fixes this: a name in KNOWN_OWNER_COLORS gets
 * its hand-picked color (purely a nicety for EC's existing users, who are
 * used to it); any other name — including every one of a new installation's
 * real reps — gets an equally distinct color, deterministically generated
 * from a hash of the name, so the SAME name always renders the SAME color
 * without needing a lookup table at all.
 */

const KNOWN_OWNER_COLORS = {
  "Yaron Drilevich": { bg: "#3B82F6", text: "white", label: "Yaron" },
  "Ethan Magen":     { bg: "#10B981", text: "white", label: "Ethan" },
  "Micky Gad":       { bg: "#F59E0B", text: "white", label: "Micky" },
  "Matt":            { bg: "#8B5CF6", text: "white", label: "Matt" },
  "Karen":           { bg: "#EC4899", text: "white", label: "Karen" },
  "Michelle Ecenski":{ bg: "#F97316", text: "white", label: "Michelle" },
};

const UNASSIGNED_COLOR = { bg: "#6B7280", text: "white", label: "Unassigned" };

// A small palette of visually-distinct, readable-on-white hues — cycled by
// hash so any name gets a stable, distinct color without a per-install
// lookup table to maintain.
const GENERATED_PALETTE = [
  "#0EA5E9", "#D946EF", "#14B8A6", "#F43F5E", "#84CC16",
  "#6366F1", "#EAB308", "#06B6D4", "#A855F7", "#F97316",
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Resolve the display color config for an owner/rep name.
 * @param {string|null|undefined} name
 * @returns {{ bg: string, text: string, label: string }}
 */
export function getOwnerColor(name) {
  if (!name) return UNASSIGNED_COLOR;
  if (KNOWN_OWNER_COLORS[name]) return KNOWN_OWNER_COLORS[name];
  const bg = GENERATED_PALETTE[hashString(name) % GENERATED_PALETTE.length];
  const label = String(name).trim().split(/\s+/)[0] || name;
  return { bg, text: "white", label };
}

export { KNOWN_OWNER_COLORS, UNASSIGNED_COLOR };
