import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AddendumPanel from './AddendumPanel';

vi.mock('@/api/railway/deals', () => ({
  getAddendums: vi.fn(),
  list: vi.fn(),
  convertToAddendum: vi.fn(),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import * as railwayDeals from '@/api/railway/deals';

describe('AddendumPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders nothing for a non-admin viewer when the deal has no addendums and is not itself one', async () => {
    railwayDeals.getAddendums.mockResolvedValue({ addendums: [], original_contract_amount: 33000, approved_addendums_amount: 0, total_approved_contract: 33000 });
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
    });
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={false} />);
    await waitFor(() => expect(screen.getByText('Parent Project / Addendums')).toBeTruthy());
    expect(screen.getByText('$40934.35')).toBeTruthy();
    expect(screen.getByText(/Bathroom repair/)).toBeTruthy();
  });

  it('shows the admin conversion control with eligible sibling deals, excluding the deal itself and anything already an addendum', async () => {
    railwayDeals.getAddendums.mockResolvedValue({ addendums: [], original_contract_amount: 33000, approved_addendums_amount: 0, total_approved_contract: 33000 });
    railwayDeals.list.mockResolvedValue({
      items: [
        { id: 'roof', name: 'Roof Job', amount: 33000, parent_deal_id: null },
        { id: 'bath', name: 'Bathroom repair', amount: 7934.35, parent_deal_id: null },
        { id: 'already-addendum', name: 'Already Linked', amount: 500, parent_deal_id: 'something-else' },
      ],
    });
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={true} />);
    await waitFor(() => expect(screen.getByText(/Select a deal/)).toBeTruthy());
    expect(screen.queryByText(/Roof Job/)).toBeNull(); // the deal itself must never offer itself
    expect(screen.getByText(/Bathroom repair/)).toBeTruthy();
    expect(screen.queryByText(/Already Linked/)).toBeNull(); // already has a parent elsewhere
  });

  it('non-admin never sees the conversion control', async () => {
    railwayDeals.getAddendums.mockResolvedValue({ addendums: [{ id: 'bath', name: 'Bathroom repair', amount: 7934.35 }], original_contract_amount: 33000, approved_addendums_amount: 7934.35, total_approved_contract: 40934.35 });
    render(<AddendumPanel deal={{ id: 'roof', parent_deal_id: null }} lead={{ id: 'l1' }} isAdmin={false} />);
    await waitFor(() => expect(screen.getByText('Parent Project / Addendums')).toBeTruthy());
    expect(screen.queryByText('Convert')).toBeNull();
  });
});
