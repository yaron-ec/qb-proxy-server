/**
 * FinancialsTab.salesRep.test.jsx — split into its own file because the
 * sales_rep role must be mocked at module load time (vi.mock is hoisted),
 * and FinancialsTab.test.jsx already mocks @/lib/AuthContext for admin.
 * Confirms the November 2026 redesign left the sales_rep view completely
 * unaffected: still the simple customer-facing Collections/Payment
 * Schedule/Commission view, never the new Financial Summary hero or the
 * Expandable Details accordion (margin/profit/cost data stays
 * management-only, unchanged from before this redesign).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FinancialsTab from './FinancialsTab';

vi.mock('@/api/railway/deals', () => ({
  update: vi.fn().mockResolvedValue({ deal: {} }),
  getAddendums: vi.fn().mockResolvedValue({ addendums: [], original_contract_amount: 0, approved_addendums_amount: 0, total_approved_contract: 0 }),
  list: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock('@/api/railway/dealExpenses', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/dealExpensePayments', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/dealCommissions', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/dealLoanPayments', () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock('@/api/railway/activities', () => ({ list: vi.fn().mockResolvedValue({ items: [] }), create: vi.fn() }));
vi.mock('@/api/railway/dealFinancials', () => ({
  getFinancials: vi.fn().mockResolvedValue({ invoices: [], waterfall: null, waterfallError: null }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const AUTH = { user: { email: 'rep@ecconstructiongroup.com', role: 'sales_rep' } };
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => AUTH }));

function deal(overrides = {}) {
  return { id: 'deal-1', lead_id: 'lead-1', amount: 50000, status: 'In Progress', ...overrides };
}
function lead(overrides = {}) {
  return { id: 'lead-1', first_name: 'Ali', last_name: 'Lalani', ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('FinancialsTab (sales_rep): unaffected by the redesign — still the simple customer-facing view, no accordion', () => {
  it('renders Collections only, never the Financial Summary hero or the Expandable Details accordion', async () => {
    render(<FinancialsTab deal={deal()} lead={lead()} invoices={[]} setDeal={vi.fn()} setLead={vi.fn()} refreshLead={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('CUSTOMER COLLECTIONS')).toBeInTheDocument());
    expect(screen.queryByTestId('financial-summary-card')).toBeNull();
    expect(screen.queryByTestId('fin-expandable-details')).toBeNull();
  });
});
