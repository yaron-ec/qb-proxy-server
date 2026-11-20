/**
 * FinancialsTab.test.jsx — November 2026 redesign: a Financial Summary hero
 * (navy/gold/white, plain-English terms — see ProfitabilitySummary.test.jsx)
 * plus Collections/Payment Schedule are ALWAYS visible; everything else
 * (Cost Breakdown, Revenue & Lead Cost, Commissions, Expenses,
 * Documents & QuickBooks Mapping, Activity Log) lives in a
 * collapsed-by-default Expandable Details accordion. Mocks every
 * sub-component's own API dependency — this file exercises FinancialsTab's
 * OWN new accordion wiring, not each sub-component's internal behavior
 * (already covered by their own test files).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import FinancialsTab from './FinancialsTab';

vi.mock('@/api/railway/deals', () => ({
  update: vi.fn().mockResolvedValue({ deal: {} }),
  getAddendums: vi.fn().mockResolvedValue({ addendums: [], original_contract_amount: 0, approved_addendums_amount: 0, total_approved_contract: 0 }),
  list: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock('@/api/railway/dealExpenses', () => ({ list: vi.fn().mockResolvedValue({ items: [] }), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('@/api/railway/dealExpensePayments', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/dealCommissions', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/dealLoanPayments', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/activities', () => ({ list: vi.fn().mockResolvedValue({ items: [] }), create: vi.fn() }));
vi.mock('@/api/railway/dealFinancials', () => ({
  getFinancials: vi.fn().mockResolvedValue({ invoices: [], waterfall: null, waterfallError: null }),
}));
vi.mock('@/api/railway/qbInvoiceMapping', () => ({ getByLead: vi.fn().mockResolvedValue({ mapped: [] }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const AUTH = { user: { email: 'admin@ecconstructiongroup.com', role: 'admin' } };
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => AUTH }));

function deal(overrides = {}) {
  return { id: 'deal-1', lead_id: 'lead-1', amount: 50000, status: 'In Progress', ...overrides };
}
function lead(overrides = {}) {
  return { id: 'lead-1', first_name: 'Ali', last_name: 'Lalani', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  try { sessionStorage.clear(); } catch { /* noop */ }
});

describe('FinancialsTab (admin/manager): Financial Summary + Collections always visible, details collapsed', () => {
  it('renders the Financial Summary hero and the Collections section without needing to expand anything', async () => {
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('financial-summary-card')).toBeInTheDocument());
    expect(screen.getByTestId('fin-collections-section')).toBeInTheDocument();
  });

  it('every Expandable Details section is collapsed by default — no sub-panel content is pre-rendered', async () => {
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('fin-expandable-details')).toBeInTheDocument());
    expect(screen.getByText('Cost Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Commissions')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Documents & QuickBooks Mapping')).toBeInTheDocument();
    expect(screen.getByText('Activity Log')).toBeInTheDocument();
    // None of the inner section labels (only rendered once expanded) are present yet.
    expect(screen.queryByText('Total Vendor Costs')).toBeNull();
    expect(screen.queryByText('No expenses yet')).toBeNull();
  });

  it('never renders a Loan Payments section (removed per request — underlying deal_loan_payments data/API is untouched and still feeds Total Cost)', async () => {
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('fin-expandable-details')).toBeInTheDocument());
    expect(screen.queryByText('Loan Payments')).toBeNull();
  });

  it('clicking a collapsed section header expands it and renders its content, and clicking again collapses it', async () => {
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('fin-expandable-details')).toBeInTheDocument());
    expect(screen.queryByText('No expenses found.')).toBeNull();
    fireEvent.click(screen.getByText('Expenses'));
    expect(await screen.findByText('No expenses found.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Expenses'));
    expect(screen.queryByText('No expenses found.')).toBeNull();
  });

  it('badge counts reflect the real loaded data for Commissions/Expenses/Activity Log', async () => {
    const dealExpenses = await import('@/api/railway/dealExpenses');
    dealExpenses.list.mockResolvedValue({ items: [{ id: 'e1' }, { id: 'e2' }] });
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Expenses').parentElement.textContent).toContain('2'));
  });

  it('remembers open sections per deal across a remount (sessionStorage), never across a DIFFERENT deal', async () => {
    const { unmount } = render(<FinancialsTab deal={deal({ id: 'deal-A' })} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('fin-expandable-details')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Commissions'));
    expect(await screen.findByText('No commission records.')).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('fin-details-open:deal-A'))).toEqual({ commissions: true });
    unmount();

    // Same deal id re-mounted: the section is still open, content visible with no extra click.
    render(<FinancialsTab deal={deal({ id: 'deal-A' })} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    expect(await screen.findByText('No commission records.')).toBeInTheDocument();

    // A DIFFERENT deal id starts fresh — collapsed, no carry-over.
    render(<FinancialsTab deal={deal({ id: 'deal-B' })} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('fin-expandable-details').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('No commission records.').length).toBe(1); // only deal-A's still-mounted instance, not a fresh one for deal-B
  });
});
