/**
 * formatters.test.jsx — regression coverage for the production date defect:
 * Deal Overview showed "Sold Date: Aug 23, 2026" while the new Deal Activity
 * timeline showed "Deal Sold: Aug 22, 2026" for the SAME deals.sold_date
 * value. Root cause: sold_date (like every other business date field) is
 * stored as literal midnight UTC of the intended calendar day, but was run
 * through fmtDate — a REAL-TIMESTAMP formatter that explicitly converts to
 * America/Los_Angeles. UTC midnight always rolls back to the previous
 * Pacific calendar day, so any date-only value shown via fmtDate is
 * guaranteed to display one day early.
 *
 * fmtDate itself is correct and unchanged for real instants (created_at, an
 * upload timestamp, a signature timestamp) — the fix is the new
 * fmtBusinessDate, used for DATE-only business fields instead.
 */
import { describe, it, expect } from 'vitest';
import { fmtDate, fmtBusinessDate } from './formatters';

describe('fmtBusinessDate — DATE-only business fields, no timezone conversion ever', () => {
  it('REGRESSION: the exact production case — sold_date stored as UTC midnight Aug 23 renders as Aug 23, not Aug 22', () => {
    expect(fmtBusinessDate('2026-08-23T00:00:00.000Z')).toBe('Aug 23, 2026');
  });

  it('renders a bare YYYY-MM-DD string identically to the same value with a time component', () => {
    expect(fmtBusinessDate('2026-08-23')).toBe('Aug 23, 2026');
    expect(fmtBusinessDate('2026-08-23T00:00:00.000Z')).toBe('Aug 23, 2026');
  });

  it('accepts a JS Date object representing UTC midnight of the intended day', () => {
    expect(fmtBusinessDate(new Date('2026-08-23T00:00:00.000Z'))).toBe('Aug 23, 2026');
  });

  it('is stable across both sides of the 2026 US DST transitions (no seasonal one-day drift)', () => {
    expect(fmtBusinessDate('2026-03-07T00:00:00.000Z')).toBe('Mar 7, 2026');
    expect(fmtBusinessDate('2026-03-08T00:00:00.000Z')).toBe('Mar 8, 2026');
    expect(fmtBusinessDate('2026-03-09T00:00:00.000Z')).toBe('Mar 9, 2026');
    expect(fmtBusinessDate('2026-10-31T00:00:00.000Z')).toBe('Oct 31, 2026');
    expect(fmtBusinessDate('2026-11-01T00:00:00.000Z')).toBe('Nov 1, 2026');
    expect(fmtBusinessDate('2026-11-02T00:00:00.000Z')).toBe('Nov 2, 2026');
  });

  it('holds in winter (PST/UTC-8) just as it does in summer (PDT/UTC-7) — not a lucky-season coincidence', () => {
    expect(fmtBusinessDate('2026-01-15T00:00:00.000Z')).toBe('Jan 15, 2026');
  });

  it('returns an em dash for null/undefined/empty, never throws', () => {
    expect(fmtBusinessDate(null)).toBe('—');
    expect(fmtBusinessDate(undefined)).toBe('—');
    expect(fmtBusinessDate('')).toBe('—');
  });
});

describe('fmtDate — REAL timestamps still correctly convert to the Pacific business timezone (unchanged)', () => {
  it('a genuine late-UTC instant correctly lands on the prior Pacific calendar day — this is CORRECT for a real instant', () => {
    // 2026-08-23T02:00:00Z is 2026-08-22 19:00 PDT (UTC-7) — a real event
    // that happened at 7pm Pacific on Aug 22 SHOULD show Aug 22, not Aug 23.
    expect(fmtDate('2026-08-23T02:00:00.000Z')).toBe('Aug 22, 2026');
  });

  it('demonstrates why the two formatters are NOT interchangeable: the same UTC-midnight instant renders differently depending on which one is used', () => {
    const utcMidnight = '2026-08-23T00:00:00.000Z';
    expect(fmtDate(utcMidnight)).toBe('Aug 22, 2026'); // wrong for a business date, correct for a real instant
    expect(fmtBusinessDate(utcMidnight)).toBe('Aug 23, 2026'); // correct for a business date
  });
});
