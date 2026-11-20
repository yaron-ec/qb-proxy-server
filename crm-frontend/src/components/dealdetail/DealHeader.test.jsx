import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DealHeader from './DealHeader';

const deal = { id: 'roof', name: 'Roof Replacement', stage: 'Sold / Estimate Approved', amount: 33000, parent_deal_id: null };
const lead = { id: 'l1', first_name: 'Ali', last_name: 'Lalani' };

function renderHeader(props = {}) {
  return render(
    <MemoryRouter>
      <DealHeader deal={deal} lead={lead} onAddProject={() => {}} onDeleteDeal={() => {}} {...props} />
    </MemoryRouter>
  );
}

describe('DealHeader — Add Addendum button', () => {
  it('"+ Add Project" is always rendered, unaffected by admin/addendum state', () => {
    renderHeader({ isAdmin: false });
    expect(screen.getByText('Add Project')).toBeTruthy();
  });

  it('shows "Add Addendum" for an admin viewing a non-addendum deal', () => {
    renderHeader({ isAdmin: true });
    expect(screen.getByText('Add Addendum')).toBeTruthy();
  });

  it('hides "Add Addendum" for a non-admin', () => {
    renderHeader({ isAdmin: false });
    expect(screen.queryByText('Add Addendum')).toBeNull();
  });

  it('hides "Add Addendum" when this deal is itself an addendum (one level deep only)', () => {
    renderHeader({ isAdmin: true, deal: { ...deal, parent_deal_id: 'some-parent' } });
    expect(screen.queryByText('Add Addendum')).toBeNull();
  });

  it('calls onAddAddendum when clicked', () => {
    const onAddAddendum = vi.fn();
    renderHeader({ isAdmin: true, onAddAddendum });
    fireEvent.click(screen.getByText('Add Addendum'));
    expect(onAddAddendum).toHaveBeenCalled();
  });
});
