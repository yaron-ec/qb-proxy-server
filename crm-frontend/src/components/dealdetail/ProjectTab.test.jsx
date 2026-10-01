/**
 * ProjectTab.test.jsx — regression coverage for the horizontal-consistency
 * fix: Deal Detail used to have TWO divergent Project Type editors — this
 * tab's own free-text EditableInfoRow (any string could be saved, bypassing
 * the canonical vocabulary entirely) and Overview tab's canonical
 * ProjectTypeSelector. This tab now uses the same ProjectTypeSelector,
 * backed by the same lib/projectTypes.js#EC_PROJECT_TYPES source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ProjectTab from './ProjectTab';
import { EC_PROJECT_TYPES } from '@/lib/projectTypes';

vi.mock('@/components/HandoffEstimatesPanel', () => ({ default: () => <div /> }));
const getSetting = vi.fn().mockResolvedValue({ key: 'app_lists', value: {} });
vi.mock('@/api/railway/settings', () => ({
  get: (...args) => getSetting(...args),
}));

function baseDeal(overrides = {}) {
  return { id: 'deal-1', work_start_date: '', work_end_date: '', project_type: '', ...overrides };
}
const lead = { id: 'lead-1' };

beforeEach(() => { getSetting.mockClear(); });

describe('ProjectTab — Project Type uses the canonical ProjectTypeSelector, not free text', () => {
  it('opens the canonical picker (not a text input) and shows the full EC_PROJECT_TYPES list', async () => {
    render(<ProjectTab deal={baseDeal({ project_type: 'Roofing' })} lead={lead} updateField={vi.fn()} setLead={vi.fn()} saving={null} />);
    fireEvent.click(screen.getByText('Project Type'));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked());
    for (const type of EC_PROJECT_TYPES) expect(screen.getByRole('checkbox', { name: type })).toBeInTheDocument();
    // No free-text input for Project Type any more.
    expect(screen.queryByDisplayValue('Roofing')).toBeNull();
  });

  it('saving calls updateField("project_type", ...) with the joined canonical selection', async () => {
    const updateField = vi.fn().mockResolvedValue(undefined);
    render(<ProjectTab deal={baseDeal({ project_type: 'Roofing' })} lead={lead} updateField={updateField} setLead={vi.fn()} saving={null} />);
    fireEvent.click(screen.getByText('Project Type'));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateField).toHaveBeenCalledWith('project_type', 'Roofing, Kitchen Remodel'));
  });
});
