/**
 * OwnerDirectoryTab.test.jsx — Reply-To Contact Directory (owners table)
 * inline edit.
 *
 * Production defect: the Owner Directory Settings tab only ever showed the
 * `users` table (a completely different table from `owners`, which
 * ActivityComposer.jsx's resolveOwnerEmail() actually reads for Reply-To).
 * There was no application path at all to fix a stale owners.email value.
 * This adds a second, editable section bound to the real `owners` table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import OwnerDirectoryTab from './OwnerDirectoryTab';

const apiCall = vi.fn();
vi.mock('@/api/railway/client', () => ({ apiCall: (...a) => apiCall(...a) }));

const listOwners = vi.fn();
const updateOwner = vi.fn();
vi.mock('@/api/railway/owners', () => ({
  list: (...a) => listOwners(...a),
  update: (...a) => updateOwner(...a),
}));

beforeEach(() => {
  apiCall.mockReset();
  apiCall.mockResolvedValue({ items: [] });
  listOwners.mockReset();
  updateOwner.mockReset();
});

describe('Reply-To Contact Directory', () => {
  it('shows the real owners table (a legacy stale email), separate from the Users list above', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true }] });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('Reply-To Contact Directory')).toBeTruthy());
    expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy();
  });

  it('admin can edit the stale email to the canonical company address', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true }] });
    updateOwner.mockResolvedValue({ owner: { id: 'o1', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich', is_active: true } });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Edit'));
    const emailInput = screen.getByPlaceholderText('email@ecconstructiongroup.com');
    fireEvent.change(emailInput, { target: { value: 'yaron@ecconstructiongroup.com' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => expect(updateOwner).toHaveBeenCalledWith('o1', { email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich' }));
    await waitFor(() => expect(screen.getByText('yaron@ecconstructiongroup.com')).toBeTruthy());
    expect(screen.queryByText('yaron.ecrenewables@gmail.com')).toBeNull();
  });

  it('surfaces a save error (e.g. invalid email / conflict) without losing the edit', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true }] });
    updateOwner.mockRejectedValue(new Error('invalid email'));
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(screen.getByText('invalid email')).toBeTruthy());
  });

  it('hides edit controls entirely for a read-only (non-admin) viewer', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true }] });
    render(<OwnerDirectoryTab readOnly />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());
    expect(screen.queryByTitle('Edit')).toBeNull();
  });
});
