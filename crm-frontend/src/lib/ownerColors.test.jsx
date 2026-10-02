/**
 * ownerColors.test.js — regression coverage for a productization defect:
 * pages/DailyMap.jsx's OWNER_COLORS was a flat object keyed by EC's own
 * roster of rep names; any rep not in that list (i.e. EVERY rep at any
 * installation other than EC) fell back to the same gray "Unassigned"
 * color, so a new company's Daily Map could never distinguish between its
 * own real, active reps.
 */
import { describe, it, expect } from 'vitest';
import { getOwnerColor, KNOWN_OWNER_COLORS, UNASSIGNED_COLOR } from './ownerColors';

describe('getOwnerColor', () => {
  it('returns the Unassigned color for a falsy name', () => {
    expect(getOwnerColor(null)).toEqual(UNASSIGNED_COLOR);
    expect(getOwnerColor(undefined)).toEqual(UNASSIGNED_COLOR);
    expect(getOwnerColor('')).toEqual(UNASSIGNED_COLOR);
  });

  it('returns EC\'s hand-picked color for a known EC name (no behavior change for EC)', () => {
    expect(getOwnerColor('Yaron Drilevich')).toEqual(KNOWN_OWNER_COLORS['Yaron Drilevich']);
    expect(getOwnerColor('Ethan Magen')).toEqual(KNOWN_OWNER_COLORS['Ethan Magen']);
  });

  it('REGRESSION: an unrecognized name (any Company #2 rep) gets a distinct, non-gray color — never flattened to Unassigned', () => {
    const color = getOwnerColor('Jordan Admin');
    expect(color.bg).not.toBe(UNASSIGNED_COLOR.bg);
    expect(color.label).toBe('Jordan');
  });

  it('is deterministic: the same unrecognized name always gets the same color', () => {
    expect(getOwnerColor('Taylor Rep')).toEqual(getOwnerColor('Taylor Rep'));
  });

  it('gives different unrecognized names visually distinct colors (not all collapsed to one fallback)', () => {
    const a = getOwnerColor('Alex Rep A');
    const b = getOwnerColor('Blair Rep B');
    const c = getOwnerColor('Casey Rep C');
    const colors = new Set([a.bg, b.bg, c.bg]);
    expect(colors.size).toBeGreaterThan(1);
  });
});
