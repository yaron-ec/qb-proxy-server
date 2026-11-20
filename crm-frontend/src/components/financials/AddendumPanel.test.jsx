import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AddendumPanel from './AddendumPanel';

describe('AddendumPanel (Master Project Summary) — pure display, data via props', () => {
  it('renders nothing when the deal has no addendums and is not itself one', () => {
    const data = { addendums: [], original_contract_amount: 33000, approved_addendums_amount: 0, total_approved_contract: 33000, master: null };
    const { container } = render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} data={data} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing while data is still loading (null)', () => {
    const { container } = render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} data={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows the contract-structure breakdown matching the Lalani case ($33,000 + $7,934.35 = $40,934.35)', () => {
    const data = {
      addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 7934.35 }],
      original_contract_amount: 33000,
      approved_addendums_amount: 7934.35,
      total_approved_contract: 40934.35,
      master: { invoiced: 40934.35, collected: 25000, outstanding: 15934.35, total_costs: 2500, projected_profit: 38434.35, profit_margin_pct: 93.9, has_invoiced_vs_contract_discrepancy: false, invoiced_vs_contract_discrepancy: 0, per_deal: [] },
    };
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} data={data} />);
    expect(screen.getByText('Master Project Summary')).toBeTruthy();
    expect(screen.getByText('$40,934.35')).toBeTruthy(); // Combined Contract Value (not duplicated by invoiced here, since no discrepancy banner shows it)
    expect(screen.getByText(/Bathroom repair/)).toBeTruthy();
  });

  it('never shows the consolidated financial metrics — those live in ProfitabilitySummary now, not duplicated here', () => {
    const data = {
      addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 7934.35 }],
      original_contract_amount: 33000, approved_addendums_amount: 7934.35, total_approved_contract: 40934.35,
      master: { invoiced: 40934.35, collected: 25000, outstanding: 15934.35, total_costs: 2500, projected_profit: 38434.35, profit_margin_pct: 93.9, has_invoiced_vs_contract_discrepancy: false, invoiced_vs_contract_discrepancy: 0, per_deal: [] },
    };
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} data={data} />);
    expect(screen.queryByText('Projected Profit')).toBeNull();
    expect(screen.queryByText('Profit Margin')).toBeNull();
    expect(screen.queryByText('Collected')).toBeNull();
    expect(screen.queryByText('Convert')).toBeNull();
    expect(screen.queryByText(/Select a deal/)).toBeNull();
  });

  it('shows the addendum-of-another-project note when this deal itself is an addendum', () => {
    const data = { addendums: [], original_contract_amount: 40934.35, approved_addendums_amount: 0, total_approved_contract: 40934.35, master: null };
    render(<AddendumPanel deal={{ id: 'bath', parent_deal_id: 'roof' }} data={data} />);
    expect(screen.getByText(/is an/)).toBeTruthy();
    expect(screen.getByText('addendum')).toBeTruthy();
  });

  it('shows the discrepancy banner (never force-reconciled) when invoiced diverges from the combined contract value', () => {
    const data = {
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
    };
    render(<AddendumPanel deal={{ id: 'main', parent_deal_id: null }} data={data} />);
    expect(screen.getByTestId('invoiced-vs-contract-discrepancy-banner')).toBeTruthy();
    expect(screen.getByText(/exceeds the Combined Contract Value/)).toBeTruthy();
    expect(screen.getByText(/\$500\.00/)).toBeTruthy();
    expect(screen.getByText('$12,000.00')).toBeTruthy();
  });

  it('shows no discrepancy banner when master is null (e.g. aggregation failed server-side)', () => {
    const data = { addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 2000 }], original_contract_amount: 10000, approved_addendums_amount: 2000, total_approved_contract: 12000, master: null };
    render(<AddendumPanel deal={{ id: 'main', parent_deal_id: null }} data={data} />);
    expect(screen.queryByTestId('invoiced-vs-contract-discrepancy-banner')).toBeNull();
  });
});
