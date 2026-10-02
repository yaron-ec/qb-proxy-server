/**
 * Reports.canonicalMetrics.test.jsx — regression coverage for a found-in-audit
 * drift defect: Reports.jsx computed "Sold This Month" / "Revenue This Month"
 * and its "Active" lead count using its OWN inline logic instead of this
 * app's shared canonical helpers, which Dashboard.jsx / Deals.jsx /
 * FollowUpsWidget.jsx / LeadsModern.jsx already use.
 *
 * Two concrete drift bugs this caused:
 *
 * 1. Month boundary: the old code did
 *      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
 *      if (sd >= thisMonth) { soldThisMonth++; ... }
 *    — `new Date(y, m, 1)` and `now.getMonth()` use the BROWSER's LOCAL
 *    timezone, not America/Los_Angeles (the business's actual timezone,
 *    lib/dashboardMetrics.js's documented authoritative boundary), and the
 *    `>=` check has no upper bound, so a future-dated deal would also count
 *    as "sold this month". Near a month boundary (e.g. 9pm-midnight Pacific
 *    on the last day of the month, viewed from a browser in a timezone ahead
 *    of Pacific) this could show a different "Sold This Month" count than
 *    Dashboard/Deals for the exact same data.
 *
 * 2. Active count: the old code excluded only `['DNQ', 'Lost']`, while the
 *    shared lib/activeLeadFilter.js#isActiveSalesLead additionally excludes
 *    'Sold' (and several other inactive/legacy statuses) — so Reports'
 *    "Active" stat double-counted Sold leads as still active, diverging from
 *    Dashboard/LeadsModern's "Active" count for the same lead set.
 *
 * FIX: both now reuse the shared helpers (lib/dashboardMetrics.js#computeDealMetrics,
 * lib/activeLeadFilter.js#isActiveSalesLead) instead of reimplementing the logic.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'Reports.jsx'), 'utf8');

describe('Reports.jsx uses the shared canonical metrics helpers (no reimplemented drift-prone logic)', () => {
  it('imports and calls computeDealMetrics for sales metrics', () => {
    expect(src).toMatch(/import \{ formatDashboardCurrency, computeDealMetrics \} from ["']@\/lib\/dashboardMetrics["']/);
    expect(src).toMatch(/computeDealMetrics\(deals\)/);
  });

  it('REGRESSION: no longer reimplements its own browser-local-timezone month boundary for "sold this month"', () => {
    expect(src).not.toMatch(/new Date\(now\.getFullYear\(\), now\.getMonth\(\), 1\)/);
    expect(src).not.toMatch(/sd >= thisMonth/);
  });

  it('imports and uses isActiveSalesLead for the Active lead count', () => {
    expect(src).toMatch(/import \{ isActiveSalesLead \} from ["']@\/lib\/activeLeadFilter["']/);
    expect(src).toMatch(/active: leads\.filter\(isActiveSalesLead\)\.length/);
  });

  it('REGRESSION: no longer uses the narrower inline Active check that double-counted Sold leads as active', () => {
    expect(src).not.toMatch(/!\['DNQ', 'Lost'\]\.includes\(l\.status\)/);
  });

  it('still computes its own per-rep and per-project-type sold breakdowns (no shared-helper equivalent exists for these)', () => {
    expect(src).toMatch(/salesByRep\[rep\]\.count\+\+/);
    expect(src).toMatch(/projectTypesSold\[pt\] = \(projectTypesSold\[pt\] \|\| 0\) \+ 1/);
  });
});
