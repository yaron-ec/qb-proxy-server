/**
 * FollowUpsWidget.dealsUnavailable.test.jsx — regression coverage for a
 * found-in-audit defect: Dashboard.jsx's deals fetch was wrapped in a bare
 * `.catch(() => ({ items: [] }))`, so any failure OR denial (e.g. the
 * `office` role, which lib/dealModel.js#resolveDealScope intentionally
 * denies all deal access to — deals carry financial data) silently became
 * an empty deals array. FollowUpsWidget's "Sold This Month"/"Revenue This
 * Month" cards then showed a real-looking "0"/"$0", indistinguishable from
 * an honest zero.
 *
 * FIX: Dashboard.jsx now tracks whether the deals fetch actually failed and
 * passes a `dealsUnavailable` prop through; FollowUpsWidget shows "—"
 * instead of a fabricated 0/$0 for those two cards when set, and leaves
 * every unrelated metric exactly as computed from the leads/deals it DID
 * get.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FollowUpsWidget from './FollowUpsWidget';

function renderWidget(props) {
  return render(<MemoryRouter><FollowUpsWidget {...props} /></MemoryRouter>);
}

function baseLead(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Jann', last_name: 'Ziegenhohn', status: 'New',
    follow_up_date: null, follow_up_type: null,
    ...overrides,
  };
}

describe('FollowUpsWidget dealsUnavailable', () => {
  it('REGRESSION: shows "—" (not a fabricated "0"/"$0") for Sold This Month / Revenue This Month when dealsUnavailable is true', () => {
    renderWidget({
      leads: [baseLead()],
      allLeads: [baseLead()],
      deals: [],
      dealsUnavailable: true,
    });
    expect(screen.getByText('Sold This Month')).toBeInTheDocument();
    expect(screen.getByText('Revenue This Month')).toBeInTheDocument();
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('shows a real computed value (not "—") when dealsUnavailable is false/omitted, even if it is genuinely zero', () => {
    renderWidget({
      leads: [baseLead()],
      allLeads: [baseLead()],
      deals: [],
    });
    // Genuinely zero deals this month → real "0", not the unavailable dash.
    expect(screen.getByText('Sold This Month')).toBeInTheDocument();
    expect(screen.getByText('$0')).toBeInTheDocument();
  });
});
