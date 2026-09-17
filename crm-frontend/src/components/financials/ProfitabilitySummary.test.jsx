/**
 * ProfitabilitySummary.test.jsx — regression coverage for the Financials
 * visual redesign: the previous full-bleed dark navy hero with oversized
 * monospace (.fin-figure-lg) numbers is gone, replaced with the same
 * card-premium + typography-section-header language used everywhere else
 * in the CRM (see components/dealdetail/OverviewTab.jsx). Verifies actual
 * rendered output, not source-string assertions.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProfitabilitySummary from './ProfitabilitySummary';

function fin(overrides = {}) {
  return {
    totalRevenue: 50000,
    totalCosts: 25300,
    netProfit: 24700,
    profitMargin: 49.4,
    ...overrides,
  };
}

describe('ProfitabilitySummary — no dark hero, matches CRM visual language', () => {
  it('does not render the old dark gradient hero background', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    expect(container.querySelector('.from-slate-900')).toBeNull();
    expect(container.querySelector('.bg-gradient-to-br')).toBeNull();
  });

  it('does not use the monospace fin-figure-lg typography', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    expect(container.querySelector('.fin-figure-lg')).toBeNull();
    expect(container.querySelector('.fin-figure')).toBeNull();
  });

  it('uses the shared card-premium + typography-section-header convention', () => {
    const { container } = render(<ProfitabilitySummary fin={fin()} />);
    expect(container.querySelector('.card-premium')).toBeInTheDocument();
    expect(screen.getByText('JOB PROFITABILITY')).toHaveClass('typography-section-header');
  });

  it('renders all four metrics with correct values', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('Project Value')).toBeInTheDocument();
    expect(screen.getByText('$50,000.00')).toBeInTheDocument();
    expect(screen.getByText('Total Costs')).toBeInTheDocument();
    expect(screen.getByText('$25,300.00')).toBeInTheDocument();
    expect(screen.getByText('Projected Profit')).toBeInTheDocument();
    expect(screen.getByText('$24,700.00')).toBeInTheDocument();
    expect(screen.getByText('Profit Margin')).toBeInTheDocument();
    expect(screen.getByText('49.4%')).toBeInTheDocument();
  });

  it('positive profit renders in restrained emerald, not the old bright emerald-300-on-dark treatment', () => {
    render(<ProfitabilitySummary fin={fin()} />);
    expect(screen.getByText('$24,700.00')).toHaveClass('text-emerald-700');
    expect(screen.getByText('49.4%')).toHaveClass('text-emerald-700');
  });

  it('negative profit renders in restrained rose, and Total Costs stays neutral (a cost is not "bad" for existing)', () => {
    render(<ProfitabilitySummary fin={fin({ totalCosts: 45152.90, netProfit: -42094.90, profitMargin: -1376.5 })} />);
    expect(screen.getByText('-$42,094.90')).toHaveClass('text-rose-700');
    expect(screen.getByText('-1376.5%')).toHaveClass('text-rose-700');
    expect(screen.getByText('$45,152.90')).toHaveClass('text-slate-900');
  });

  it('zero project value does not crash and renders 0% profit bar segments safely', () => {
    expect(() => {
      render(<ProfitabilitySummary fin={fin({ totalRevenue: 0, totalCosts: 0, netProfit: 0, profitMargin: 0 })} />);
    }).not.toThrow();
  });
});
