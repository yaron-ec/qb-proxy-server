import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * MobileDayView.unassigned.test.jsx — the "Unassigned" owner quick-filter
 * (My Day / mobile day view) previously matched only a falsy assigned_rep
 * (`!l.assigned_rep`). leads.owner_id is NOT NULL, so "Unassigned" is a
 * real, canonical `owners` row (display_name='Unassigned', seeded during
 * the Base44->Railway migration) — assigned_rep for these leads is the
 * literal string "Unassigned", never falsy. The old check could never
 * match a real production lead. Source-level check (this component has
 * heavy geolocation/native-maps dependencies that make a full render test
 * disproportionate here) that the fix is present.
 */
const src = fs.readFileSync(path.join(process.cwd(), 'src/pages/MobileDayView.jsx'), 'utf8');

describe('MobileDayView — Unassigned owner filter matches the real canonical value', () => {
  it('matches the literal "Unassigned" assigned_rep, not just a falsy value', () => {
    const match = src.match(/ownerFilter === "Unassigned"[\s\S]{0,350}/);
    expect(match).toBeTruthy();
    expect(match[0]).toMatch(/assigned_rep === "Unassigned"/);
  });
});
