/**
 * ProjectTypeSelector.test.jsx — regression coverage for the "Deal Detail
 * Project Type editor opens with an empty body" production defect.
 *
 * ROOT CAUSE: this component's modal options came ONLY from
 * GET /api/v1/settings/app_lists (routes/settings.js#requireAdminOrManager —
 * admin/manager only). A sales_rep editing their OWN deal's Project Type
 * (allowed by lib/dealModel.js#canWriteDeal) gets a 403 from that fetch; the
 * component silently caught the error and left its `projectTypes` state as
 * the empty array it started with — rendering a modal with no checkboxes at
 * all, exactly as reported. Every other Project Type consumer in the CRM
 * (LeadCapture.jsx, Settings.jsx, LeadDetailModern.jsx) avoids this exact
 * failure by defaulting to the canonical EC_PROJECT_TYPES constant
 * (lib/projectTypes.js) and only overriding it when the optional live
 * settings fetch actually succeeds with a non-empty list — this component
 * now does the same.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectTypeSelector from './ProjectTypeSelector';
import { EC_PROJECT_TYPES } from '@/lib/projectTypes';

const getSetting = vi.fn();
vi.mock('@/api/railway/settings', () => ({
  get: (...args) => getSetting(...args),
}));

beforeEach(() => {
  getSetting.mockReset();
});

function openModal() {
  fireEvent.click(screen.getByText('Project Type'));
}

describe('ProjectTypeSelector — canonical options always render (no empty modal body)', () => {
  it('REGRESSION: a 403 from the admin/manager-gated settings endpoint (e.g. a sales_rep) still shows the full canonical EC_PROJECT_TYPES list, not an empty body', async () => {
    getSetting.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(<ProjectTypeSelector value={null} onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith('app_lists'));
    for (const type of EC_PROJECT_TYPES) {
      expect(screen.getByText(type)).toBeInTheDocument();
    }
    expect(screen.queryByText('No project types configured.')).toBeNull();
  });

  it('a settings row that exists but has no (or an empty) projectTypes value still shows the canonical list, never an empty body', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: { projectTypes: [] } });
    render(<ProjectTypeSelector value={null} onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    expect(screen.getByText('Kitchen Remodel')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').length).toBe(EC_PROJECT_TYPES.length);
  });

  it('a successful, non-empty live settings fetch overrides the canonical default with the configured list', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: { projectTypes: ['Custom Type A', 'Custom Type B'] } });
    render(<ProjectTypeSelector value={null} onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Custom Type A')).toBeInTheDocument());
    expect(screen.getByText('Custom Type B')).toBeInTheDocument();
    expect(screen.queryByText('Kitchen Remodel')).toBeNull();
  });
});

describe('ProjectTypeSelector — pre-selection of the existing saved value', () => {
  it('pre-selects the deal\'s currently saved project type (comma-separated string)', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    render(<ProjectTypeSelector value="Kitchen Remodel, Bathroom Remodel" onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Bathroom Remodel' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).not.toBeChecked();
  });

  it('pre-selects the deal\'s currently saved project type (array form)', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    render(<ProjectTypeSelector value={['Roofing']} onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked());
  });

  it('a deal with no project type at all shows nothing pre-checked', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    render(<ProjectTypeSelector value={null} onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(EC_PROJECT_TYPES.length));
    for (const cb of screen.getAllByRole('checkbox')) expect(cb).not.toBeChecked();
  });
});

describe('ProjectTypeSelector — save persists the selection; refresh reflects it', () => {
  it('changing the selection and clicking Save calls onSave with the new selection and closes the modal', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectTypeSelector value="Roofing" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Kitchen Remodel')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Roofing', 'Kitchen Remodel']));
    await waitFor(() => expect(screen.queryByText('Select Project Types')).toBeNull()); // modal closed
    // REGRESSION (requirement #5): the new value shows immediately, without a refresh.
    expect(screen.getByText('Kitchen Remodel')).toBeInTheDocument();
  });

  it('REGRESSION (refresh): re-rendering with the newly persisted `value` prop (simulating a page reload fetching the saved record) shows the new value pre-selected', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const { rerender } = render(<ProjectTypeSelector value="Roofing" onSave={vi.fn()} />);
    expect(screen.getByText('Roofing')).toBeInTheDocument();

    // Simulate a reload: the component remounts/re-renders with the server's
    // freshly-fetched value, exactly like Deal Detail does after GET /deals/:id.
    rerender(<ProjectTypeSelector value="Kitchen Remodel, Bathroom Remodel" onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Bathroom Remodel' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).not.toBeChecked();
  });
});

describe('ProjectTypeSelector — Cancel/X never save', () => {
  it('Cancel does not call onSave and discards the unsaved selection', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn();
    render(<ProjectTypeSelector value="Roofing" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Kitchen Remodel')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(screen.getByText('Cancel'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText('Kitchen Remodel')).toBeNull(); // modal closed

    // Reopening must show the ORIGINAL saved value, not the abandoned pick.
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).not.toBeChecked();
  });

  it('the X button does not call onSave and discards the unsaved selection', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn();
    const { container } = render(<ProjectTypeSelector value="Roofing" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Kitchen Remodel')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(container.querySelector('svg.lucide-x').closest('button'));

    expect(onSave).not.toHaveBeenCalled();
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).not.toBeChecked();
  });
});

describe('ProjectTypeSelector — Save error handling (must not silently succeed)', () => {
  it('keeps the modal open and never reports success if onSave rejects', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn().mockRejectedValue(new Error('network error'));
    render(<ProjectTypeSelector value={null} onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Roofing')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Roofing' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // Modal must still be open — a failed save must not look like a success.
    expect(screen.getByText('Select Project Types')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('shows a "Saving..." state while the save is in flight', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    let resolveSave;
    const onSave = vi.fn(() => new Promise(r => { resolveSave = r; }));
    render(<ProjectTypeSelector value={null} onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByText('Roofing')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Roofing' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByText('Saving...')).toBeInTheDocument());

    resolveSave();
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
  });
});

describe('ProjectTypeSelector — REGRESSION: case/format normalization and exact-replacement Save semantics', () => {
  // Exact production case: stored legacy/display value "ADU / garage
  // conversion, Fence" (lowercase "garage conversion") must preselect the
  // canonical "ADU / Garage Conversion" checkbox — not leave it unchecked
  // merely because the stored casing differs.
  it('a legacy-cased stored value preselects its canonical-cased checkbox equivalent', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    render(<ProjectTypeSelector value="ADU / garage conversion, Fence" onSave={vi.fn()} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Fence' })).toBeChecked();
  });

  it('REGRESSION (exact case from the bug report): unchecking the canonical checkbox for a legacy-cased stored value and saving REPLACES the persisted value with exactly the remaining checked set — never a union/append of old + new', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectTypeSelector value="ADU / garage conversion, Fence" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })).toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })); // uncheck
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Fence']));

    // Reopening shows exactly the new persisted state: ADU unchecked, Fence checked.
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Fence' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })).not.toBeChecked();
  });

  it('toggling a legacy-cased checkbox off then back on never produces a duplicate (one canonical-cased entry, not two casings of the same type)', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectTypeSelector value="adu / garage conversion" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })).toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })); // uncheck
    fireEvent.click(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })); // re-check
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['ADU / Garage Conversion'])); // exactly one entry
  });

  it('adding a new selection alongside an existing legacy-cased one saves exactly both, canonically cased — never a 3rd, differently-cased duplicate', async () => {
    getSetting.mockResolvedValue({ key: 'app_lists', value: {} });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectTypeSelector value="ADU / garage conversion" onSave={onSave} />);
    openModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ADU / Garage Conversion' })).toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Fence' })); // add
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['ADU / Garage Conversion', 'Fence']));
  });
});
