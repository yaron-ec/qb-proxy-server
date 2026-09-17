/**
 * OwnerDirectoryTab.test.jsx — Reply-To Contact Directory (owners table):
 * inline edit + admin-only duplicate merge workflow.
 *
 * Production defect: the Owner Directory Settings tab only ever showed the
 * `users` table (a completely different table from `owners`, which
 * ActivityComposer.jsx's resolveOwnerEmail() actually reads for Reply-To,
 * and which Leads/Appointments/Deals ownership actually points to). There
 * was no application path at all to fix a stale owners.email value, and no
 * way to safely consolidate two duplicate owner rows for the same real
 * person (e.g. two "Yaron Drilevich" rows, one with a legacy personal
 * email) short of a destructive direct-DB delete that would orphan every
 * record still pointing at the duplicate. This adds an editable section
 * bound to the real `owners` table, plus a preview-then-confirm merge flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import OwnerDirectoryTab from './OwnerDirectoryTab';

const apiCall = vi.fn();
vi.mock('@/api/railway/client', () => ({ apiCall: (...a) => apiCall(...a) }));

const list = vi.fn();
const listAll = vi.fn();
const updateOwner = vi.fn();
const mergePreview = vi.fn();
const mergeFn = vi.fn();
vi.mock('@/api/railway/owners', () => ({
  list: (...a) => list(...a),
  listAll: (...a) => listAll(...a),
  update: (...a) => updateOwner(...a),
  mergePreview: (...a) => mergePreview(...a),
  merge: (...a) => mergeFn(...a),
}));

const LEGACY = { id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true, merged_into_owner_id: null, reference_counts: { leads: 12, appointments: 2, deals: 3, tasks: 1, deal_commissions: 0, total: 18 } };
const CANONICAL = { id: 'o2', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich', is_active: true, merged_into_owner_id: null, reference_counts: { leads: 5, appointments: 1, deals: 2, tasks: 0, deal_commissions: 1, total: 9 } };

beforeEach(() => {
  apiCall.mockReset();
  apiCall.mockResolvedValue({ items: [] });
  list.mockReset();
  listAll.mockReset();
  updateOwner.mockReset();
  mergePreview.mockReset();
  mergeFn.mockReset();
});

describe('Reply-To Contact Directory (admin view — read-only audit + management)', () => {
  it('shows every owner (active + merged), with reference counts — separate from the Users list above', async () => {
    listAll.mockResolvedValue({ items: [LEGACY, CANONICAL] });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('Reply-To Contact Directory')).toBeTruthy());
    expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy();
    expect(screen.getByText('yaron@ecconstructiongroup.com')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy(); // legacy's reference_counts.total
  });

  it('shows a Merged badge for a deactivated duplicate, naming its canonical target', async () => {
    const merged = { ...LEGACY, is_active: false, merged_into_owner_id: 'o2', merged_at: '2026-09-17T00:00:00Z', reference_counts: { leads: 0, appointments: 0, deals: 0, tasks: 0, deal_commissions: 0, total: 0 } };
    listAll.mockResolvedValue({ items: [merged, CANONICAL] });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText(/Merged → Yaron Drilevich/)).toBeTruthy());
  });

  it('admin can edit the stale email to the canonical company address', async () => {
    listAll.mockResolvedValue({ items: [LEGACY] });
    updateOwner.mockResolvedValue({ owner: { ...LEGACY, email: 'yaron@ecconstructiongroup.com' } });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Edit'));
    const emailInput = screen.getByPlaceholderText('email@ecconstructiongroup.com');
    fireEvent.change(emailInput, { target: { value: 'yaron@ecconstructiongroup.com' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => expect(updateOwner).toHaveBeenCalledWith('o1', { email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich' }));
    await waitFor(() => expect(screen.getByText('yaron@ecconstructiongroup.com')).toBeTruthy());
  });

  it('surfaces a save error (e.g. invalid email / conflict) without losing the edit', async () => {
    listAll.mockResolvedValue({ items: [LEGACY] });
    updateOwner.mockRejectedValue(new Error('email already in use by another owner'));
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(screen.getByText('email already in use by another owner')).toBeTruthy());
  });

  it('does not offer Merge when there is only one active owner', async () => {
    listAll.mockResolvedValue({ items: [CANONICAL] });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron@ecconstructiongroup.com')).toBeTruthy());
    expect(screen.queryByTitle('Merge into another owner')).toBeNull();
  });
});

describe('Reply-To Contact Directory — merge workflow', () => {
  it('previews the merge, shows counts, and confirms — deduplicating the two Yaron rows', async () => {
    listAll.mockResolvedValue({ items: [LEGACY, CANONICAL] });
    mergePreview.mockResolvedValue({
      keep_owner: CANONICAL, merge_owner: LEGACY,
      will_repoint: { leads: 12, appointments: 2, deals: 3, tasks: 1, deal_commissions: 0 },
      preserved_historical: { lead_submissions: 4, appointment_events: 2 },
      appointment_overlap_conflicts: [], blocked: false, already_merged: false,
    });
    mergeFn.mockResolvedValue({ success: true, kept_owner_id: 'o2', merged_owner_id: 'o1', stats: {}, preserved: {} });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());

    // Open merge on the legacy row.
    const mergeButtons = screen.getAllByTitle('Merge into another owner');
    fireEvent.click(mergeButtons[0]);

    const select = screen.getByText('Select the canonical owner to keep…').closest('select');
    fireEvent.change(select, { target: { value: 'o2' } });

    await waitFor(() => expect(mergePreview).toHaveBeenCalledWith('o1', 'o2'));
    await waitFor(() => expect(screen.getByText('12 lead(s)')).toBeTruthy());
    expect(screen.getByText('2 appointment(s)')).toBeTruthy();

    fireEvent.click(screen.getByText('Confirm Merge'));
    await waitFor(() => expect(mergeFn).toHaveBeenCalledWith('o2', 'o1'));
  });

  it('disables Confirm and shows a warning when the preview reports a blocking appointment overlap', async () => {
    listAll.mockResolvedValue({ items: [LEGACY, CANONICAL] });
    mergePreview.mockResolvedValue({
      keep_owner: CANONICAL, merge_owner: LEGACY,
      will_repoint: { leads: 1, appointments: 1, deals: 0, tasks: 0, deal_commissions: 0 },
      preserved_historical: { lead_submissions: 0, appointment_events: 0 },
      appointment_overlap_conflicts: [{ merge_appt_id: 'a1', keep_appt_id: 'a2' }], blocked: true, already_merged: false,
    });
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());
    fireEvent.click(screen.getAllByTitle('Merge into another owner')[0]);
    const select = screen.getByText('Select the canonical owner to keep…').closest('select');
    fireEvent.change(select, { target: { value: 'o2' } });

    await waitFor(() => expect(screen.getByText(/Blocked:/)).toBeTruthy());
    expect(screen.getByText('Confirm Merge').closest('button')).toBeDisabled();
  });

  it('surfaces a merge submission error without crashing', async () => {
    listAll.mockResolvedValue({ items: [LEGACY, CANONICAL] });
    mergePreview.mockResolvedValue({
      keep_owner: CANONICAL, merge_owner: LEGACY,
      will_repoint: { leads: 1, appointments: 0, deals: 0, tasks: 0, deal_commissions: 0 },
      preserved_historical: { lead_submissions: 0, appointment_events: 0 },
      appointment_overlap_conflicts: [], blocked: false, already_merged: false,
    });
    mergeFn.mockRejectedValue(new Error('one or both owners not found'));
    render(<OwnerDirectoryTab />);
    await waitFor(() => expect(screen.getByText('yaron.ecrenewables@gmail.com')).toBeTruthy());
    fireEvent.click(screen.getAllByTitle('Merge into another owner')[0]);
    const select = screen.getByText('Select the canonical owner to keep…').closest('select');
    fireEvent.change(select, { target: { value: 'o2' } });
    await waitFor(() => expect(screen.getByText('Confirm Merge')).toBeTruthy());
    fireEvent.click(screen.getByText('Confirm Merge'));
    await waitFor(() => expect(screen.getByText('one or both owners not found')).toBeTruthy());
  });
});

describe('Reply-To Contact Directory — read-only (non-admin)', () => {
  it('uses the active-only list endpoint, hides audit columns and all actions', async () => {
    list.mockResolvedValue({ items: [{ id: 'o2', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich', is_active: true }] });
    render(<OwnerDirectoryTab readOnly />);
    await waitFor(() => expect(screen.getByText('yaron@ecconstructiongroup.com')).toBeTruthy());
    expect(listAll).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Edit')).toBeNull();
    expect(screen.queryByTitle('Merge into another owner')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
  });
});
