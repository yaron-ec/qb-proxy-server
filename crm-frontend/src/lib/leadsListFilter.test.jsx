/**
 * leadsListFilter.test.jsx — Active Leads' Sales Rep (owner) filter and its
 * composition with Search / Status / Website-only / Sort.
 *
 * The Sales Rep filter (ownerFilter state, admin/manager-only <select> in
 * pages/LeadsModern.jsx) already exists end to end: options are built from
 * the canonical users API (filtered to active sales roles, excluding
 * deactivated/garbage accounts) merged with real assigned_rep values seen
 * on leads — never hardcoded names — and the real authorization boundary
 * is server-side (routes/leads.js's resolveOwnerScope already returns only
 * a sales_rep's own leads, so this client-side filter can never be used to
 * see another rep's data no matter what value it's set to). This file adds
 * the previously-missing regression coverage for the composition logic
 * itself (extracted to lib/leadsListFilter.js for direct testability).
 */
import { describe, it, expect } from 'vitest';
import { filterAndSortLeads, rankSearchRelevance } from './leadsListFilter';

function lead(overrides = {}) {
  return {
    id: 'l1', first_name: 'Dean', last_name: 'Richter', status: 'Appointment Scheduled',
    assigned_rep: 'Yaron Drilevich', source: 'Referral', created_date: '2026-01-01', updated_date: '2026-01-01',
    ...overrides,
  };
}

const leads = [
  lead({ id: 'l1', first_name: 'Dean', last_name: 'Richter', assigned_rep: 'Yaron Drilevich', status: 'Appointment Scheduled', source: 'Referral' }),
  lead({ id: 'l2', first_name: 'Brian', last_name: 'Krantz', assigned_rep: 'Ethan Magen', status: 'Appointment Scheduled', source: 'Website' }),
  lead({ id: 'l3', first_name: 'Mia', last_name: 'Arias', assigned_rep: 'Yaron Drilevich', status: 'New Lead', source: 'Website' }),
  lead({ id: 'l4', first_name: 'Sam', last_name: 'Lee', assigned_rep: '', status: 'New Lead', source: 'Referral' }),
  // The REAL production shape: leads.owner_id is NOT NULL, so "unassigned"
  // is a genuine, canonical `owners` row (display_name='Unassigned') — this
  // lead's assigned_rep is the literal, non-empty string "Unassigned", not
  // an empty value like l4 above.
  lead({ id: 'l5', first_name: 'Nora', last_name: 'Feld', assigned_rep: 'Unassigned', status: 'New Lead', source: 'Website' }),
];

describe('filterAndSortLeads — Sales Rep (owner) filter', () => {
  it('"All Leads" (ownerFilter=all) returns every active lead regardless of rep', () => {
    const result = filterAndSortLeads(leads, { ownerFilter: 'all', userRole: 'admin' });
    expect(result.map(l => l.id).sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('one rep selected returns only that rep\'s leads', () => {
    const result = filterAndSortLeads(leads, { ownerFilter: 'Yaron Drilevich', userRole: 'admin' });
    expect(result.map(l => l.id).sort()).toEqual(['l1', 'l3']);
  });

  it('rep matching is case-insensitive', () => {
    const result = filterAndSortLeads(leads, { ownerFilter: 'yaron drilevich', userRole: 'admin' });
    expect(result.map(l => l.id).sort()).toEqual(['l1', 'l3']);
  });

  it('"Unassigned" returns leads with the canonical Unassigned owner AND leads with a genuinely empty assigned_rep — REGRESSION: the prior check only matched an empty string, so it could never match a real production lead (leads.owner_id is NOT NULL — every lead\'s assigned_rep is a real string, including the literal "Unassigned" placeholder owner)', () => {
    const result = filterAndSortLeads(leads, { ownerFilter: 'unassigned', userRole: 'admin' });
    expect(result.map(l => l.id).sort()).toEqual(['l4', 'l5']);
  });

  it('rep with zero matching leads returns an empty array, not a crash', () => {
    const result = filterAndSortLeads(leads, { ownerFilter: 'Nobody Real', userRole: 'admin' });
    expect(result).toEqual([]);
  });

  it('composes with Status: Status=Appointment Scheduled AND Sales Rep=Yaron Drilevich applies both', () => {
    const result = filterAndSortLeads(leads, { statusFilter: 'Appointment Scheduled', ownerFilter: 'Yaron Drilevich', userRole: 'admin' });
    expect(result.map(l => l.id)).toEqual(['l1']);
  });

  it('composes with Website Leads: Sales Rep=Yaron Drilevich AND Website-only excludes their non-Website lead', () => {
    const result = filterAndSortLeads(leads, { sourceFilter: 'website', ownerFilter: 'Yaron Drilevich', userRole: 'admin' });
    expect(result.map(l => l.id)).toEqual(['l3']);
  });

  it('composes with Sort: the rep-filtered subset is still sorted (created, newest first)', () => {
    const repLeads = [
      lead({ id: 'old', assigned_rep: 'Yaron Drilevich', created_date: '2026-01-01' }),
      lead({ id: 'new', assigned_rep: 'Yaron Drilevich', created_date: '2026-06-01' }),
    ];
    const result = filterAndSortLeads(repLeads, { ownerFilter: 'Yaron Drilevich', sortField: 'created', userRole: 'admin' });
    expect(result.map(l => l.id)).toEqual(['new', 'old']);
  });

  it('a free-text Search overrides the Sales Rep filter (deliberate existing "search everything" behavior, not a bug) — matches this repo\'s own "Showing results from all leads" banner', () => {
    const result = filterAndSortLeads(leads, { searchTerm: 'Brian', ownerFilter: 'Yaron Drilevich', userRole: 'admin' });
    // Brian Krantz is assigned to Ethan Magen, not Yaron — found anyway because search is global.
    expect(result.map(l => l.id)).toEqual(['l2']);
  });

  it('a sales_rep role always ignores the owner filter value — the client can never widen or narrow visibility beyond what the server already scoped', () => {
    // Even a maliciously/accidentally set ownerFilter to a name that isn't
    // this rep's own must not filter out server-scoped rows on the client.
    const resultAll = filterAndSortLeads(leads, { ownerFilter: 'all', userRole: 'sales_rep' });
    const resultTampered = filterAndSortLeads(leads, { ownerFilter: 'Some Other Rep', userRole: 'sales_rep' });
    expect(resultTampered.map(l => l.id).sort()).toEqual(resultAll.map(l => l.id).sort());
  });

  it('zero results across all filters renders as an empty array, not a crash', () => {
    const result = filterAndSortLeads(leads, { statusFilter: 'Closed Lost', ownerFilter: 'Yaron Drilevich', userRole: 'admin' });
    expect(result).toEqual([]);
  });

  it('handles an empty leads array safely', () => {
    expect(filterAndSortLeads([], { ownerFilter: 'Yaron Drilevich', userRole: 'admin' })).toEqual([]);
  });
});

describe('filterAndSortLeads — search relevance ranking (November 2026 production fix)', () => {
  // REGRESSION: searching "ali" previously ranked "Ali & Mohemmed Lalani"
  // far down the list — a search never changed sort order, results stayed
  // ordered by follow-up urgency regardless of match quality.
  const relevanceLeads = [
    lead({ id: 'urgent-other', first_name: 'Dean', last_name: 'Richter', follow_up_date: '2020-01-01', follow_up_status: 'pending' }),
    lead({ id: 'lalani', first_name: 'Ali & Mohemmed', last_name: 'Lalani', follow_up_date: null }),
    lead({ id: 'substring-only', first_name: 'Monica', last_name: 'Gonzalez', notes: 'spoke with her husband Ali about the quote', follow_up_date: null }),
  ];

  it('an exact-prefix name match ranks above a lead with only an unrelated notes match, and a lead with no "ali" anywhere never matches at all, regardless of follow-up urgency', () => {
    const result = filterAndSortLeads(relevanceLeads, { searchTerm: 'ali', userRole: 'admin' });
    const ids = result.map((l) => l.id);
    expect(ids.indexOf('lalani')).toBeLessThan(ids.indexOf('substring-only'));
    expect(ids).not.toContain('urgent-other'); // "Dean Richter" has no "ali" anywhere — must not match at all
  });

  it('rankSearchRelevance: tier 0 exact full name, tier 1 name begins with query, tier 2 any name token begins with query, tier 3 name contains query, tier 4 no name match', () => {
    expect(rankSearchRelevance({ first_name: 'Ali', last_name: 'Lalani' }, 'ali lalani')).toBe(0);
    expect(rankSearchRelevance({ first_name: 'Ali', last_name: 'Lalani' }, 'ali')).toBe(1);
    expect(rankSearchRelevance({ first_name: 'Ali & Mohemmed', last_name: 'Lalani' }, 'lalani')).toBe(2);
    expect(rankSearchRelevance({ first_name: 'Natalie', last_name: 'Price' }, 'ali')).toBe(3); // "natalie" contains "ali" mid-word, not at a token boundary
    expect(rankSearchRelevance({ first_name: 'Monica', last_name: 'Gonzalez' }, 'ali')).toBe(4);
    expect(rankSearchRelevance({ first_name: '', last_name: '' }, 'ali')).toBe(4);
  });

  it('an explicitly selected sort (created/updated) is honored even while searching — relevance is only the default', () => {
    const result = filterAndSortLeads(relevanceLeads, { searchTerm: 'ali', sortField: 'created', userRole: 'admin' });
    // Falls through to the plain created-date sort, never relevance, once
    // the user has explicitly chosen a sort order.
    expect(result.map((l) => l.id)).toEqual(
      [...result].sort((a, b) => new Date(b.created_date) - new Date(a.created_date)).map((l) => l.id)
    );
  });

  it('a search with zero name/field matches still returns an empty array, not a crash', () => {
    const result = filterAndSortLeads(relevanceLeads, { searchTerm: 'zzz-no-such-lead', userRole: 'admin' });
    expect(result).toEqual([]);
  });
});
