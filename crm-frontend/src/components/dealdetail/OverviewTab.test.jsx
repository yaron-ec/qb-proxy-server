/**
 * OverviewTab.test.jsx — regression coverage for the "Contract Signed" fix.
 *
 * Deal Overview used to label deal.deposit_paid_date as "Contract Signed"
 * (a mislabel — a deposit payment is not a contract signature) with a dead
 * fallback to a lead.signed_contract_date column that doesn't exist in the
 * schema. It now sources "Contract Signed" from the exact same
 * GET /api/v1/deals/:id/timeline "contract" event the Deal Activity
 * timeline already computes, and is read-only (an authoritative computed
 * fact, not something a user can silently overwrite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import OverviewTab from './OverviewTab';

const getTimeline = vi.fn();
vi.mock('@/api/railway/dealTimeline', () => ({
  getTimeline: (...args) => getTimeline(...args),
}));
vi.mock('@/api/railway/deals', () => ({ update: vi.fn() }));
vi.mock('@/api/railway/leads', () => ({ update: vi.fn() }));
vi.mock('@/api/railway/settings', () => ({
  get: vi.fn().mockResolvedValue({ app_lists: { project_types: [] } }),
  list: vi.fn().mockResolvedValue({ items: [] }),
}));

function baseDeal(overrides = {}) {
  return {
    id: 'deal-1', lead_id: 'lead-1', stage: 'Sold / Estimate Approved',
    deposit_paid_date: '2026-08-25', property_address: '123 Main St',
    assigned_rep: 'Yaron Drilevich', sold_date: '2026-08-23', notes: '',
    ...overrides,
  };
}
const lead = { id: 'lead-1', first_name: 'Dean', last_name: 'Richter', phone: '5551234567' };
const noop = () => {};

beforeEach(() => { getTimeline.mockReset(); });

describe('OverviewTab — Contract Signed sources the authoritative signnow-derived fact, not deposit_paid_date', () => {
  it('shows "Not recorded" (not the deposit_paid_date) when no authoritative Contract Signed event exists', async () => {
    getTimeline.mockResolvedValue({ events: [{ id: 'deal_sold', category: 'milestone', date: '2026-08-23' }] });
    render(<OverviewTab deal={baseDeal()} lead={lead} updateField={noop} setDeal={noop} setLead={noop} saving={null} />);
    await waitFor(() => expect(screen.getByText('Not recorded')).toBeInTheDocument());
    // The old bug: Aug 25 (deposit_paid_date) must never appear under Contract Signed.
    expect(screen.queryByText('Aug 25, 2026')).toBeNull();
  });

  it('shows the real Contract Signed date when an authoritative signnow event exists, matching Activity\'s own formatting', async () => {
    getTimeline.mockResolvedValue({
      events: [{ id: 'contract_signed:doc-1', category: 'contract', date: '2026-08-24T12:00:00.000Z', dateKind: 'instant' }],
    });
    render(<OverviewTab deal={baseDeal()} lead={lead} updateField={noop} setDeal={noop} setLead={noop} saving={null} />);
    await waitFor(() => expect(screen.getByText('Aug 24, 2026')).toBeInTheDocument());
  });

  it('the Contract Signed row is read-only — no pencil/edit affordance, unlike the editable fields around it', async () => {
    getTimeline.mockResolvedValue({ events: [] });
    const { container } = render(<OverviewTab deal={baseDeal()} lead={lead} updateField={noop} setDeal={noop} setLead={noop} saving={null} />);
    await waitFor(() => expect(screen.getByText('Not recorded')).toBeInTheDocument());
    const row = screen.getByText('Contract Signed').closest('div');
    expect(within(row.parentElement).queryByRole('img', { hidden: true })).toBeNull();
    // No cursor-pointer/group class (the pattern EditableInfoRow uses to signal it's clickable).
    expect(row.parentElement.className).not.toContain('cursor-pointer');
  });
});

describe('OverviewTab — page width (production review: narrow column left most of a wide desktop screen empty)', () => {
  it('uses PAGE_WIDTH_WIDE (max-w-[1600px]), matching Dashboard/Leads/Financials, not the old cramped max-w-4xl', async () => {
    getTimeline.mockResolvedValue({ events: [] });
    const { container } = render(<OverviewTab deal={baseDeal()} lead={lead} updateField={noop} setDeal={noop} setLead={noop} saving={null} />);
    await waitFor(() => expect(screen.getByText('Not recorded')).toBeInTheDocument());
    const root = container.firstChild;
    expect(root.className).toContain('max-w-[1600px]');
    expect(root.className).not.toContain('max-w-4xl');
  });

  it('Client and Project Info are proportioned, not an even 50/50 split, on wide desktop', async () => {
    getTimeline.mockResolvedValue({ events: [] });
    render(<OverviewTab deal={baseDeal()} lead={lead} updateField={noop} setDeal={noop} setLead={noop} saving={null} />);
    await waitFor(() => expect(screen.getByText('CLIENT')).toBeInTheDocument());
    const grid = screen.getByText('CLIENT').closest('.card-premium').parentElement;
    expect(grid.className).toContain('lg:grid-cols-[minmax(280px,380px)_1fr]');
  });
});
