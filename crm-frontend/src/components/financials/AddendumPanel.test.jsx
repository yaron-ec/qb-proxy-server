import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AddendumPanel from './AddendumPanel';

vi.mock('@/api/railway/deals', () => ({
  getAddendums: vi.fn(),
}));

import * as railwayDeals from '@/api/railway/deals';

describe('AddendumPanel (Master Project Summary)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders nothing when the deal has no addendums and is not itself one', async () => {
    railwayDeals.getAddendums.mockResolvedValue({ addendums: [], original_contract_amount: 33000, approved_addendums_amount: 0, total_approved_contract: 33000, master: null });
    const { container } = render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={false} />);
    await waitFor(() => expect(railwayDeals.getAddendums).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('shows the combined-total breakdown matching the Lalani case ($33,000 + $7,934.35 = $40,934.35)', async () => {
    railwayDeals.getAddendums.mockResolvedValue({
      addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 7934.35 }],
      original_contract_amount: 33000,
      approved_addendums_amount: 7934.35,
      total_approved_contract: 40934.35,
      master: {
        invoiced: 40934.35, collected: 25000, outstanding: 15934.35, total_costs: 2500,
        projected_profit: 38434.35, profit_margin_pct: 93.9,
        has_invoiced_vs_contract_discrepancy: false, invoiced_vs_contract_discrepancy: 0,
        per_deal: [],
      },
    });
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={false} />);
    await waitFor(() => expect(screen.getByText('Master Project Summary')).toBeTruthy());
    expect(screen.getAllByText('$40,934.35').length).toBeGreaterThanOrEqual(1); // Combined Contract Value + Invoiced (equal in this scenario)
    expect(screen.getByText(/Bathroom repair/)).toBeTruthy();
    expect(screen.getByText('$25,000.00')).toBeTruthy(); // Collected
    expect(screen.getByText('93.9%')).toBeTruthy(); // Profit Margin
  });

  it('never renders its own conversion control — that action now lives exclusively in the header "+ Add Addendum" modal', async () => {
    railwayDeals.getAddendums.mockResolvedValue({
      addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 7934.35 }],
      original_contract_amount: 33000, approved_addendums_amount: 7934.35, total_approved_contract: 40934.35,
      master: { invoiced: 40934.35, collected: 0, outstanding: 40934.35, total_costs: 0, projected_profit: 40934.35, profit_margin_pct: 100, has_invoiced_vs_contract_discrepancy: false, invoiced_vs_contract_discrepancy: 0, per_deal: [] },
    });
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={true} />);
    await waitFor(() => expect(screen.getByText('Master Project Summary')).toBeTruthy());
    expect(screen.queryByText('Convert')).toBeNull();
    expect(screen.queryByText(/Select a deal/)).toBeNull();
  });

  it('shows the addendum-of-another-project note when this deal itself is an addendum', async () => {
    railwayDeals.getAddendums.mockResolvedValue({
      addendums: [], original_contract_amount: 40934.35, approved_addendums_amount: 0, total_approved_contract: 40934.35,
      master: { invoiced: 40934.35, collected: 0, outstanding: 40934.35, total_costs: 0, projected_profit: 40934.35, profit_margin_pct: 100, has_invoiced_vs_contract_discrepancy: false, invoiced_vs_contract_discrepancy: 0, per_deal: [] },
    });
    render(<AddendumPanel deal={{ id: 'bath', parent_deal_id: 'roof' }} lead={{ id: 'l1' }} isAdmin={false} />);
    await waitFor(() => expect(screen.getByText(/is an/)).toBeTruthy());
    expect(screen.getByText('addendum')).toBeTruthy();
  });

  it('shows the discrepancy banner (never force-reconciled) when invoiced diverges from the combined contract value', async () => {
    railwayDeals.getAddendums.mockResolvedValue({
      addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 2000 }],
      original_contract_amount: 10000, approved_addendums_amount: 2000, total_approved_contract: 12000,
      master: {
        invoiced: 12500, collected: 12500, outstanding: 0, total_costs: 100, projected_profit: 11900, profit_margin_pct: 99.2,
        has_invoiced_vs_contract_discrepancy: true, invoiced_vs_contract_discrepancy: 500,
        per_deal: [
          { deal_id: 'main', deal_name: 'Main Contract', invoiced: 10500, collected: 10500, used_waterfall_fallback: false },
          { deal_id: 'bath', deal_name: 'Bathroom repair', invoiced: 2000, collected: 2000, used_waterfall_fallback: false },
        ],
      },
    });
    render(<AddendumPanel deal={{ id: 'main', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={true} />);
    await waitFor(() => expect(screen.getByTestId('invoiced-vs-contract-discrepancy-banner')).toBeTruthy());
    expect(screen.getByText(/exceeds the Combined Contract Value/)).toBeTruthy();
    expect(screen.getByText(/\$500\.00/)).toBeTruthy();
    // The contract value itself must never be shown as "corrected" to match invoiced.
    expect(screen.getByText('$12,000.00')).toBeTruthy();
  });

  it('re-fetches GET /:id/addendums when refreshKey changes (the header modal just linked a sibling)', async () => {
    railwayDeals.getAddendums.mockResolvedValue({ addendums: [], original_contract_amount: 33000, approved_addendums_amount: 0, total_approved_contract: 33000, master: null });
    const { rerender } = render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={true} refreshKey={0} />);
    await waitFor(() => expect(railwayDeals.getAddendums).toHaveBeenCalledTimes(1));
    rerender(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={true} refreshKey={1} />);
    await waitFor(() => expect(railwayDeals.getAddendums).toHaveBeenCalledTimes(2));
  });
});
