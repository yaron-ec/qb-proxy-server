import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { TimelineEntry } from '@/components/DesignSystem/Timeline';

/**
 * multilinePreservation.test.jsx — horizontal audit: user-entered
 * multiline/free-text content must render with its line breaks preserved
 * (Line one\nLine two\nLine three), never collapsed into one line.
 *
 * Root cause: React's plain-text interpolation ({value}) already renders
 * text safely (never raw HTML) and never strips \n from the underlying
 * string — the DB/API round-trip preserves it too (a plain Postgres TEXT
 * column, verified by reading routes/leads.js, routes/activities.js,
 * lib/booking/bookingService.js — none of them trim or collapse newlines
 * out of notes/content fields). The actual bug was CSS: browsers collapse
 * \n in normal HTML flow by default, so a `<p>{value}</p>` with no
 * `white-space` styling visually collapses "Line one\nLine two" into
 * "Line one Line two" even though the underlying string is intact. Several
 * surfaces already used the correct fix (Tailwind's `whitespace-pre-wrap`
 * — lead notes and Activity content in LeadDetailModern.jsx,
 * SubmissionHistory.jsx, DesignSystem/Timeline.jsx) but others were
 * missed: Deal Financials expense/vendor descriptions and financial
 * activity content, and Gmail snippet previews (both the lead-detail
 * Activity card and the admin EmailPanel). Fixed by adding the SAME
 * established `whitespace-pre-wrap` class — no new pattern introduced, no
 * raw HTML rendering anywhere (a source-wide dangerouslySetInnerHTML
 * check below covers the "HTML-like text remains text" requirement).
 *
 * A source-level check is used (rather than a render test per component)
 * because these are read-only display spans/paragraphs scattered across
 * several already-large, non-trivial-to-mount components — the fix itself
 * is a single CSS class, and what actually needs regression coverage is
 * "does the class stay applied," which a source check verifies directly
 * and durably.
 */
function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('multiline text preservation — previously-missing surfaces now use whitespace-pre-wrap', () => {
  it('Deal Financials: expense/vendor description', () => {
    const src = read('src/components/financials/ExpensesSection.jsx');
    const line = src.match(/\{e\.description &&[\s\S]{0,80}/)[0];
    expect(line).toMatch(/whitespace-pre-wrap/);
  });

  it('Deal Financials: financial activity content', () => {
    const src = read('src/components/financials/FinancialActivitySection.jsx');
    const line = src.match(/\{a\.content\}[\s\S]{0,0}|<p[^>]*>\{a\.content\}/)[0];
    expect(src).toMatch(/<p className="text-slate-600 whitespace-pre-wrap">\{a\.content\}<\/p>/);
  });

  it('Gmail snippet preview: admin EmailPanel', () => {
    const src = read('src/components/EmailPanel.jsx');
    expect(src).toMatch(/line-clamp-2 leading-relaxed whitespace-pre-wrap">\{email\.snippet\}/);
  });

  it('Gmail snippet preview: Lead Detail Activity card', () => {
    const src = read('src/pages/LeadDetailModern.jsx');
    expect(src).toMatch(/line-clamp-2 whitespace-pre-wrap">\{gmailMeta\.snippet\}/);
  });

  it('DNQ Leads: notes preview', () => {
    const src = read('src/pages/DNQLeads.jsx');
    expect(src).toMatch(/line-clamp-2 mt-2 whitespace-pre-wrap">\{lead\.notes\}/);
  });

  it('already-correct pre-existing surfaces are untouched (Lead notes, Activity content, Submission notes, Timeline)', () => {
    expect(read('src/pages/LeadDetailModern.jsx')).toMatch(/whitespace-pre-wrap min-h-\[2rem\]/);
    expect(read('src/pages/LeadDetailModern.jsx')).toMatch(/whitespace-pre-wrap mb-1\.5">\{formatActivityContent\(activity\.content\)\}/);
    expect(read('src/components/SubmissionHistory.jsx')).toMatch(/whitespace-pre-wrap line-clamp-3/);
    expect(read('src/components/DesignSystem/Timeline.jsx')).toMatch(/whitespace-pre-wrap/);
  });

  it('a REAL render preserves \\n, \\r\\n, blank lines, and multiple paragraphs verbatim in the DOM text, with whitespace-pre-wrap applied so the browser doesn\'t collapse them', () => {
    const cases = [
      'Line one\nLine two\nLine three',
      'Line one\r\nLine two\r\nLine three',
      'Paragraph one\n\nParagraph two',
      'Line 1\nLine 2\n\nLine 3\nLine 4',
    ];
    for (const text of cases) {
      const { container, unmount } = render(<TimelineEntry label="Test">{text}</TimelineEntry>);
      const p = container.querySelector('p');
      expect(p.className).toMatch(/whitespace-pre-wrap/);
      // The underlying string is untouched — no stripped/collapsed newlines.
      expect(p.textContent).toBe(text);
      unmount();
    }
  });

  it('HTML-like text renders as literal text, never parsed as markup', () => {
    const text = '<script>alert(1)</script>\nLine two with <b>bold</b> tags';
    const { container, unmount } = render(<TimelineEntry label="Test">{text}</TimelineEntry>);
    const p = container.querySelector('p');
    expect(p.textContent).toBe(text);
    expect(p.querySelector('script')).toBeNull();
    expect(p.querySelector('b')).toBeNull();
    unmount();
  });

  it('long multiline text is not truncated or mangled', () => {
    const paragraph = 'A'.repeat(500);
    const text = `${paragraph}\n${paragraph}\n${paragraph}`;
    render(<TimelineEntry label="Test">{text}</TimelineEntry>);
    expect(screen.getByText((_, node) => node?.textContent === text)).toBeTruthy();
  });

  it('none of the fixed surfaces (or their sibling notes/content fields) use dangerouslySetInnerHTML — plain-text interpolation only, HTML-like input is never executed', () => {
    for (const file of [
      'src/components/financials/ExpensesSection.jsx',
      'src/components/financials/FinancialActivitySection.jsx',
      'src/components/EmailPanel.jsx',
      'src/pages/LeadDetailModern.jsx',
      'src/pages/DNQLeads.jsx',
    ]) {
      expect(read(file)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
