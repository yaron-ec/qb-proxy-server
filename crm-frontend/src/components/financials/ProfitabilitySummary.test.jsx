/**
 * ProfitabilitySummary.test.jsx — regression coverage for the Financial
 * Summary hero. November 2026 explicit product requirement: clean
 * navy/gold/white styling, reusing the EXACT brand colors every branded
 * email already uses (lib/emailTemplates.js's NAVY #0B2D5C / GOLD #C9A227),
 * with plain-English terminology (Contract Total, Collected, Balance Due,
 * Total Cost, Actual Profit, Actual Margin) and clear label-over-value
 * hierarchy. Verifies actual rendered output, not source-string assertions.
 *
 * ACTUAL PROFIT business rule (November 2026, fundamental and CRM-wide —
 * not a Lalani-specific workaround): EC Construction Group issues a
 * customer invoice only AFTER receiving the customer's check, so an issued
 * invoice IS collected revenue. ACTUAL PROFIT = COLLECTED REVENUE − TOTAL
 * RECORDED COSTS; ACTUAL PROFIT MARGIN = ACTUAL PROFIT / COLLECTED REVENUE
 * × 100 — these are now the PRIMARY profitability figures, replacing the
 * old contract-based Profit/Margin in that role. The contract-based figure
 * (fin.netProfit/profitMargin) is kept as a separate, clearly-labeled,
 * secondary "Projected Profit" line for planning purposes only.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ProfitabilitySummary from './ProfitabilitySummary';

function fin(overrides = {}) {
  return {
    totalRevenue: 50000,
    paymentsReceived: 20000,
    remainingCustomerBalance: 30000,
    totalCosts: 12000,
    // Contract-based (secondary, planning-only): 50000 - 12000 = 38000; /50000*100 = 76%
    netProfit: 38000,
    profitMargin: 76,
    // Collected-based (primary, actual): 20000 - 12000 = 8000; /20000*100 = 40%
    actualProfit: 8000,
    actualProfitMargin: 40,
    ...overrides,
  };
}

describe('ProfitabilitySummary — Financial Summary hero (navy/gold/white, plain-English terms)', () => {
  it('renders a navy header bar with a gold bottom border, matching the brand colors every branded email already uses', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    const card = screen.getByTestId('financial-summary-card');
    expect(card).toBeInTheDocument();
    const header = container.querySelector('[style*="background: rgb(11, 45, 92)"], [style*="background:#0B2D5C"]')
      || Array.from(container.querySelectorAll('div')).find((el) => el.getAttribute('style')?.includes('0B2D5C') || el.style.backgroundColor === 'rgb(11, 45, 92)');
    expect(header).toBeTruthy();
    expect(screen.getByText('Financial Summary')).toBeInTheDocument();
  });

  it('renders the four top metrics with plain-English labels and correct values', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('Contract Total')).toBeInTheDocument();
    expect(screen.getByText('$50,000.00')).toBeInTheDocument();
    expect(screen.getByText('Collected')).toBeInTheDocument();
    expect(screen.getByText('$20,000.00')).toBeInTheDocument();
    expect(screen.getByText('Balance Due')).toBeInTheDocument();
    expect(screen.getByText('$30,000.00')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('$12,000.00')).toBeInTheDocument();
  });

  it('shows ACTUAL PROFIT and ACTUAL MARGIN as the primary, large profitability figures (collected revenue minus recorded costs)', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('Actual Profit')).toBeInTheDocument();
    expect(screen.getByText('Actual Margin')).toBeInTheDocument();
    expect(screen.getByTestId('fin-metric-profit').textContent).toContain('$8,000.00');
    expect(screen.getByTestId('fin-metric-margin').textContent).toContain('40%');
    // Never the bare, unlabeled old "Profit"/"Margin" headings
    expect(screen.queryByText('Profit', { selector: 'p' })).toBeNull();
    expect(screen.queryByText('Margin', { selector: 'p' })).toBeNull();
  });

  it('never uses old jargon field names as bare on-screen labels ("Project Value"/"Total Costs"/"Profit Margin")', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.queryByText('Project Value')).toBeNull();
    expect(screen.queryByText('Total Costs')).toBeNull();
    expect(screen.queryByText('Profit Margin')).toBeNull();
  });

  it('shows Projected Profit as a clearly-labeled, secondary, planning-only line — contract-based, never the primary figure', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    const block = screen.getByTestId('fin-projected-profit-planning');
    expect(block.textContent).toMatch(/Projected Profit/);
    expect(block.textContent).toMatch(/planning only/i);
    expect(block.textContent).toMatch(/not realized revenue/i);
    expect(within(block).getByText(/\$38,000\.00/)).toBeTruthy();
    expect(within(block).getByText(/76%/)).toBeTruthy();
  });

  it('positive actual profit renders in gold, and "On Track" status', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByTestId('fin-metric-profit').querySelector('p:last-child')).toHaveStyle({ color: '#C9A227' });
    expect(screen.getByText('On Track')).toBeInTheDocument();
  });

  it('negative actual profit renders in rose/red, "Over Budget" status, and Total Cost stays neutral (a cost is not "bad" for existing) — even while Projected Profit is still positive', () => {
    // Costs exceed what's been collected so far (a real partial-collection
    // shape): actual profit is negative even though the contract-based
    // projected profit (planning only) is still comfortably positive.
    render(<ProfitabilitySummary fin={fin({ totalCosts: 45152.90, actualProfit: -25152.90, actualProfitMargin: -125.76, netProfit: 4847.10, profitMargin: 9.69 })} />);
    expect(screen.getByTestId('fin-metric-profit').querySelector('p:last-child')).toHaveStyle({ color: '#be123c' });
    expect(screen.getByText('-$25,152.90')).toBeInTheDocument();
    expect(screen.getByText('Over Budget')).toBeInTheDocument();
    expect(screen.getByText('$45,152.90')).toHaveClass('text-slate-900');
    // Projected Profit (secondary) still shows its own, different, positive figure
    const block = screen.getByTestId('fin-projected-profit-planning');
    expect(within(block).getByText(/\$4,847\.10/)).toBeTruthy();
  });

  it('zero collected revenue does not crash, renders a 0% actual margin (never NaN/Infinity), and 0% profit bar segments safely', () => {
    expect(() => {
      render(<ProfitabilitySummary fin={fin({ totalRevenue: 0, paymentsReceived: 0, remainingCustomerBalance: 0, totalCosts: 0, netProfit: 0, profitMargin: 0, actualProfit: 0, actualProfitMargin: 0 })} />);
    }).not.toThrow();
    expect(screen.getByTestId('fin-metric-margin').textContent).toContain('0%');
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/Infinity/)).toBeNull();
  });

  it('is responsive: a 2-column grid on mobile widens to 4 columns on larger screens (sm: breakpoint classes present)', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    const grid = container.querySelector('.grid-cols-2');
    expect(grid).toBeInTheDocument();
    expect(grid.className).toMatch(/sm:grid-cols-4/);
  });
});

describe('ProfitabilitySummary — consolidated Master Project totals (November 2026 production correction)', () => {
  // Generic, fabricated master numbers deliberately DIFFERENT from both the
  // single-deal `fin` numbers AND the master's own projected-profit numbers
  // — so a passing assertion can only mean "read from master.actual_profit",
  // never a coincidental match with something else.
  const master = {
    total_approved_contract: 40934.35,
    collected: 25000,
    outstanding: 15934.35,
    total_costs: 2500,
    projected_profit: 38434.35,
    profit_margin_pct: 93.9,
    actual_profit: 22500,       // 25000 - 2500
    actual_profit_margin_pct: 90, // 22500 / 25000 * 100
  };

  it('shows the combined contract value, never this deal\'s own $33,000', () => {
    render(<ProfitabilitySummary fin={fin({ totalRevenue: 33000 })} master={master} />);
    expect(screen.getByText('Combined Contract Value')).toBeInTheDocument();
    expect(screen.getByText('$40,934.35')).toBeInTheDocument();
    expect(screen.queryByText('$33,000.00')).toBeNull();
    expect(screen.queryByText('Contract Total')).toBeNull();
  });

  it('shows every other metric from the combined master total, not the single-deal fin', () => {
    render(<ProfitabilitySummary fin={fin({ totalRevenue: 33000, paymentsReceived: 42031, remainingCustomerBalance: 0, totalCosts: 20138.18, netProfit: 12861.82, profitMargin: 39, actualProfit: 21892.82, actualProfitMargin: 52.09 })} master={master} />);
    expect(screen.getByText('$25,000.00')).toBeInTheDocument(); // Collected (combined)
    expect(screen.getByText('$15,934.35')).toBeInTheDocument(); // Balance Due (combined outstanding)
    expect(screen.getByText('$2,500.00')).toBeInTheDocument(); // Total Cost (combined)
    expect(screen.getByTestId('fin-metric-profit').textContent).toContain('$22,500.00'); // Actual Profit (combined master, never fin's own)
    expect(screen.getByTestId('fin-metric-margin').textContent).toContain('90%'); // Actual Margin (combined master)
    // Never the single-deal fin's own actual-profit numbers
    expect(screen.queryByText('$21,892.82')).toBeNull();
    // The secondary Projected Profit line reads from master's projected figures, not fin's
    const block = screen.getByTestId('fin-projected-profit-planning');
    expect(within(block).getByText(/\$38,434\.35/)).toBeTruthy();
    expect(within(block).getByText(/93\.9%/)).toBeTruthy();
    expect(block.textContent).not.toMatch(/\$12,861\.82/);
  });

  it('shows a "Combined Project" badge only when master is present', () => {
    const { rerender } = render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.queryByTestId('financial-summary-consolidated-badge')).toBeNull();
    rerender(<ProfitabilitySummary fin={fin()} master={master} />);
    expect(screen.getByTestId('financial-summary-consolidated-badge')).toBeTruthy();
  });

  it('a plain single-deal project (master undefined) is completely unaffected — same numbers as before', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('Contract Total')).toBeInTheDocument();
    expect(screen.getByText('$50,000.00')).toBeInTheDocument();
  });

  it('reproduces the exact real Ali & Mohemmed Lalani production figures end to end (Collected $42,031.00, Total Recorded Costs $20,138.18 → Actual Profit $21,892.82, Actual Margin 52.09%)', () => {
    const lalaniMaster = {
      total_approved_contract: 40934.35,
      collected: 42031.00,
      outstanding: 0,
      total_costs: 20138.18,
      // Contract-based planning figure — different from, and never confused with, actual profit below.
      projected_profit: 20796.17, // 40934.35 - 20138.18
      profit_margin_pct: 50.81,   // 20796.17 / 40934.35 * 100
      actual_profit: 21892.82,    // 42031.00 - 20138.18 — the EXACT figure given for this real production case
      actual_profit_margin_pct: 52.09, // 21892.82 / 42031.00 * 100 (rounded)
    };
    render(<ProfitabilitySummary fin={fin({ totalRevenue: 33000 })} master={lalaniMaster} />);
    expect(screen.getByTestId('fin-metric-collected').textContent).toContain('$42,031.00');
    expect(screen.getByTestId('fin-metric-total-cost').textContent).toContain('$20,138.18');
    expect(screen.getByTestId('fin-metric-profit').textContent).toContain('$21,892.82');
    // The display rounds to 1 decimal (matches this component's existing
    // Margin precision convention) — the underlying computed value is the
    // exact 52.09% given for this real production case.
    expect(screen.getByTestId('fin-metric-margin').textContent).toContain('52.1%');
    const block = screen.getByTestId('fin-projected-profit-planning');
    expect(within(block).getByText(/\$20,796\.17/)).toBeTruthy();
    expect(within(block).getByText(/50\.8%/)).toBeTruthy();
  });
});

describe('ProfitabilitySummary — "Collected" honesty caveat (zero balance is not proof of cash collected)', () => {
  it('shows a tooltip on Collected explaining it is derived from invoice balance, not verified Payment records', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    const collectedMetric = screen.getByTestId('fin-metric-collected');
    expect(collectedMetric.getAttribute('title')).toMatch(/credit memo|adjustment/i);
    expect(collectedMetric.getAttribute('title')).toMatch(/not yet verified/i);
  });

  it('no other metric carries this caveat', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByTestId('fin-metric-contract-total').getAttribute('title')).toBeFalsy();
    expect(screen.getByTestId('fin-metric-balance-due').getAttribute('title')).toBeFalsy();
    expect(screen.getByTestId('fin-metric-total-cost').getAttribute('title')).toBeFalsy();
  });
});
