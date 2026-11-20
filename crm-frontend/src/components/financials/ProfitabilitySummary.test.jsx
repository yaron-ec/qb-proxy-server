/**
 * ProfitabilitySummary.test.jsx — regression coverage for the Financial
 * Summary hero. November 2026 explicit product requirement: clean
 * navy/gold/white styling, reusing the EXACT brand colors every branded
 * email already uses (lib/emailTemplates.js's NAVY #0B2D5C / GOLD #C9A227),
 * with plain-English terminology (Contract Total, Collected, Balance Due,
 * Total Cost, Profit, Margin) and clear label-over-value hierarchy — this
 * supersedes the PRIOR redesign's "no dark hero" assertions (that pass's
 * real complaint was numbers carrying weight through raw size rather than
 * hierarchy, not navy/gold itself). Verifies actual rendered output, not
 * source-string assertions.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProfitabilitySummary from './ProfitabilitySummary';

function fin(overrides = {}) {
  return {
    totalRevenue: 50000,
    paymentsReceived: 20000,
    remainingCustomerBalance: 30000,
    totalCosts: 25300,
    netProfit: 24700,
    profitMargin: 49.4,
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

  it('renders all six metrics with plain-English labels and correct values', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('Contract Total')).toBeInTheDocument();
    expect(screen.getByText('$50,000.00')).toBeInTheDocument();
    expect(screen.getByText('Collected')).toBeInTheDocument();
    expect(screen.getByText('$20,000.00')).toBeInTheDocument();
    expect(screen.getByText('Balance Due')).toBeInTheDocument();
    expect(screen.getByText('$30,000.00')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('$25,300.00')).toBeInTheDocument();
    expect(screen.getByText('Profit')).toBeInTheDocument();
    expect(screen.getByText('$24,700.00')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
    expect(screen.getByText('49.4%')).toBeInTheDocument();
  });

  it('never uses jargon field names as on-screen labels ("Project Value"/"Projected Profit"/"Total Costs" from the old design)', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.queryByText('Project Value')).toBeNull();
    expect(screen.queryByText('Projected Profit')).toBeNull();
    expect(screen.queryByText('Total Costs')).toBeNull();
    expect(screen.queryByText('Profit Margin')).toBeNull();
  });

  it('positive profit renders in gold, and "On Track" status', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByTestId('fin-metric-profit').querySelector('p:last-child')).toHaveStyle({ color: '#C9A227' });
    expect(screen.getByText('On Track')).toBeInTheDocument();
  });

  it('negative profit renders in rose/red, "Over Budget" status, and Total Cost stays neutral (a cost is not "bad" for existing)', () => {
    render(<ProfitabilitySummary fin={fin({ totalCosts: 45152.90, netProfit: -42094.90, profitMargin: -1376.5 })} />);
    expect(screen.getByTestId('fin-metric-profit').querySelector('p:last-child')).toHaveStyle({ color: '#be123c' });
    expect(screen.getByText('-$42,094.90')).toBeInTheDocument();
    expect(screen.getByText('Over Budget')).toBeInTheDocument();
    expect(screen.getByText('$45,152.90')).toHaveClass('text-slate-900');
  });

  it('zero contract total does not crash and renders 0% profit bar segments safely', () => {
    expect(() => {
      render(<ProfitabilitySummary fin={fin({ totalRevenue: 0, paymentsReceived: 0, remainingCustomerBalance: 0, totalCosts: 0, netProfit: 0, profitMargin: 0 })} />);
    }).not.toThrow();
  });

  it('is responsive: a 2-column grid on mobile widens to 4 columns on larger screens (sm: breakpoint classes present)', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    const grid = container.querySelector('.grid-cols-2');
    expect(grid).toBeInTheDocument();
    expect(grid.className).toMatch(/sm:grid-cols-4/);
  });
});

describe('ProfitabilitySummary — consolidated Master Project totals (November 2026 production correction)', () => {
  // Real production shape: a $33,000 parent deal's own `fin` vs. the
  // combined $40,934.35 project total (parent + Bathroom Repair addendum)
  // — the hero must show the COMBINED figures, never the single-deal ones,
  // once a `master` prop is supplied, so it can never again disagree with
  // the Master Project Summary panel below it.
  const master = {
    total_approved_contract: 40934.35,
    collected: 25000,
    outstanding: 15934.35,
    total_costs: 2500,
    projected_profit: 38434.35,
    profit_margin_pct: 93.9,
  };

  it('shows the combined contract value, never this deal\'s own $33,000', () => {
    render(<ProfitabilitySummary fin={fin({ totalRevenue: 33000 })} master={master} />);
    expect(screen.getByText('Combined Contract Value')).toBeInTheDocument();
    expect(screen.getByText('$40,934.35')).toBeInTheDocument();
    expect(screen.queryByText('$33,000.00')).toBeNull();
    expect(screen.queryByText('Contract Total')).toBeNull();
  });

  it('shows every other metric from the combined master total, not the single-deal fin', () => {
    render(<ProfitabilitySummary fin={fin({ totalRevenue: 33000, paymentsReceived: 42031, remainingCustomerBalance: 0, totalCosts: 20138.18, netProfit: 12861.82, profitMargin: 39 })} master={master} />);
    expect(screen.getByText('$25,000.00')).toBeInTheDocument(); // Collected (combined)
    expect(screen.getByText('$15,934.35')).toBeInTheDocument(); // Balance Due (combined outstanding)
    expect(screen.getByText('$2,500.00')).toBeInTheDocument(); // Total Cost (combined)
    expect(screen.getByText('$38,434.35')).toBeInTheDocument(); // Profit (combined)
    expect(screen.getByText('93.9%')).toBeInTheDocument(); // Margin (combined)
    // Never the stale, pre-fix single-deal numbers the real production report showed
    expect(screen.queryByText('$42,031.00')).toBeNull();
    expect(screen.queryByText('$20,138.18')).toBeNull();
    expect(screen.queryByText('$12,861.82')).toBeNull();
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
