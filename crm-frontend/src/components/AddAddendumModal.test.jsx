import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AddAddendumModal from './AddAddendumModal';

vi.mock('@/api/railway/deals', () => ({
  list: vi.fn(),
  convertToAddendum: vi.fn(),
}));

import * as railwayDeals from '@/api/railway/deals';

const deal = { id: 'roof', name: 'Roof Replacement' };
const lead = { id: 'l1', first_name: 'Ali', last_name: 'Lalani' };

describe('AddAddendumModal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('excludes the deal itself and any deal already an addendum from the eligible list', async () => {
    railwayDeals.list.mockResolvedValue({
      items: [
        { id: 'roof', name: 'Roof Replacement', amount: 33000, parent_deal_id: null },
        { id: 'bath', name: 'Bathroom Repair', amount: 7934.35, parent_deal_id: null },
        { id: 'already', name: 'Already Linked', amount: 500, parent_deal_id: 'something-else' },
      ],
    });
    render(<AddAddendumModal deal={deal} lead={lead} onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bathroom Repair/)).toBeTruthy());
    expect(screen.queryByText(/Roof Replacement \(/)).toBeNull();
    expect(screen.queryByText(/Already Linked/)).toBeNull();
  });

  it('shows a message and disables submit when there are no eligible projects', async () => {
    railwayDeals.list.mockResolvedValue({ items: [{ id: 'roof', name: 'Roof Replacement', amount: 33000, parent_deal_id: null }] });
    render(<AddAddendumModal deal={deal} lead={lead} onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No other eligible projects/)).toBeTruthy());
    expect(screen.getByText('Link as Addendum').closest('button')).toBeDisabled();
  });

  it('requires both a selected deal and a reason before submitting', async () => {
    railwayDeals.list.mockResolvedValue({ items: [{ id: 'bath', name: 'Bathroom Repair', amount: 7934.35, parent_deal_id: null }] });
    render(<AddAddendumModal deal={deal} lead={lead} onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Bathroom Repair/)).toBeTruthy());
    fireEvent.click(screen.getByText('Link as Addendum'));
    expect(await screen.findByText('Select a deal to link as an addendum.')).toBeTruthy();
    expect(railwayDeals.convertToAddendum).not.toHaveBeenCalled();
  });

  it('calls convertToAddendum with the parent_deal_id and reason, then fires onSuccess', async () => {
    railwayDeals.list.mockResolvedValue({ items: [{ id: 'bath', name: 'Bathroom Repair', amount: 7934.35, parent_deal_id: null }] });
    railwayDeals.convertToAddendum.mockResolvedValue({ success: true });
    const onSuccess = vi.fn();
    render(<AddAddendumModal deal={deal} lead={lead} onClose={() => {}} onSuccess={onSuccess} />);
    await waitFor(() => expect(screen.getByText(/Bathroom Repair/)).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bath' } });
    fireEvent.change(screen.getByPlaceholderText(/Approved bathroom repair/), { target: { value: 'Approved change order' } });
    fireEvent.click(screen.getByText('Link as Addendum'));
    await waitFor(() => expect(railwayDeals.convertToAddendum).toHaveBeenCalledWith('bath', { parent_deal_id: 'roof', reason: 'Approved change order' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('shows the server error message on a failed conversion and never calls onSuccess', async () => {
    railwayDeals.list.mockResolvedValue({ items: [{ id: 'bath', name: 'Bathroom Repair', amount: 7934.35, parent_deal_id: null }] });
    railwayDeals.convertToAddendum.mockRejectedValue(Object.assign(new Error('fail'), { data: { message: 'cross_lead' } }));
    const onSuccess = vi.fn();
    render(<AddAddendumModal deal={deal} lead={lead} onClose={() => {}} onSuccess={onSuccess} />);
    await waitFor(() => expect(screen.getByText(/Bathroom Repair/)).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bath' } });
    fireEvent.change(screen.getByPlaceholderText(/Approved bathroom repair/), { target: { value: 'reason' } });
    fireEvent.click(screen.getByText('Link as Addendum'));
    expect(await screen.findByText('cross_lead')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
