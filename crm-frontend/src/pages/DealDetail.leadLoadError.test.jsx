/**
 * DealDetail.leadLoadError.test.jsx — regression coverage for a found-in-audit
 * defect: DealDetail.jsx's lead fetch was `d.lead_id ? await
 * railwayLeads.get(d.lead_id).catch(() => null) : null` — collapsing TWO
 * different situations into the identical `lead: null` state:
 *   1. The deal genuinely has no lead_id (a real non-link).
 *   2. The deal HAS a lead_id, but fetching that lead failed or was denied
 *      — e.g. a cross-model authorization divergence where
 *      lib/dealModel.js#canAccessDeal grants this deal (candidate/created_by
 *      match) but routes/leads.js's resolveOwnerScope denies the linked
 *      lead itself.
 * Both rendered the exact same "No lead linked to this deal" banner,
 * masking a real authorization defect behind a message implying there was
 * simply never a link to begin with.
 *
 * FIX: track whether the lead fetch actually failed (leadLoadError) when
 * d.lead_id was present, and show a distinct, accurately-worded banner for
 * that case instead of the generic "no lead linked" message.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'DealDetail.jsx'), 'utf8');

describe('DealDetail.jsx distinguishes a failed/denied lead fetch from a genuine non-link', () => {
  it('REGRESSION: the initial load no longer uses a bare `.catch(() => null)` that can\'t tell failure from non-link', () => {
    const loadBlock = src.match(/\/\/ Load deal[\s\S]*?\}, \[id\]\);/)[0];
    expect(loadBlock).toMatch(/let leadFailed = false;/);
    expect(loadBlock).toMatch(/\.catch\(\(\) => \{ leadFailed = true; return null; \}\)/);
    expect(loadBlock).toMatch(/setLeadLoadError\(!!d\.lead_id && leadFailed\)/);
  });

  it('refreshLead also tracks the same leadLoadError distinction', () => {
    const refreshBlock = src.match(/const refreshLead = async \(\) => \{[\s\S]*?\n  \};/)[0];
    expect(refreshBlock).toMatch(/let leadFailed = false;/);
    expect(refreshBlock).toMatch(/setLeadLoadError\(!!d\.lead_id && leadFailed\)/);
  });

  it('renders a distinct, accurately-worded banner when the lead fetch failed vs. a genuine non-link', () => {
    expect(src).toMatch(/\{!lead && leadLoadError && \(/);
    expect(src).toMatch(/Couldn't load this deal's linked customer — you may not have access to it\./);
    expect(src).toMatch(/\{!lead && !leadLoadError && \(/);
    expect(src).toMatch(/No lead linked to this deal — customer info is unavailable\./);
  });
});
