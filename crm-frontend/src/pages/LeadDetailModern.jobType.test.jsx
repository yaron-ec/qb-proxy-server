/**
 * LeadDetailModern.jobType.test.jsx — regression coverage for the production
 * defect: Lead Detail's "Job Type" inline editor (Lead / Project section)
 * opened with an empty checkbox list — just Save/Cancel, no options.
 *
 * ROOT CAUSE: this screen's EditableField(type="multiselect") options come
 * from a `projectTypes` state variable initialized to the canonical
 * EC_PROJECT_TYPES default, then PLACED entirely from the composite
 * GET /by-external/:externalRef/detail response's `projectTypes` field.
 * routes/leads.js always returns `projectTypes: appLists.projectTypes || []`
 * — a real, empty array whenever the app_settings 'app_lists' row doesn't
 * exist or has no projectTypes saved (true for this installation). The old
 * code did `if (data.projectTypes) pTypes = data.projectTypes;` — and `[]`
 * is truthy in JS — so that empty array silently overwrote the canonical
 * default, leaving the multiselect with zero options to render.
 *
 * This is a DIFFERENT component than components/ProjectTypeSelector.jsx
 * (fixed in a prior PR for Deal Detail) — LeadDetailModern.jsx defines its
 * own EditableField component and never calls railwaySettings.get at all,
 * which is exactly why the prior audit (which traced `app_lists`/
 * railwaySettings.get call sites) didn't catch this one: the unsafe
 * override here comes through the lead-detail composite payload instead.
 *
 * FIX: only override the canonical default when the response actually has a
 * non-empty projectTypes array (Array.isArray + length check, the same
 * pattern already used in LeadCapture.jsx and components/ProjectTypeSelector.jsx),
 * plus a belt-and-suspenders fallback to EC_PROJECT_TYPES at the Job Type
 * field's own call site, plus resetting the multiselect selection on Cancel
 * (it previously only reset the single-value `editVal`, leaking an abandoned
 * checkbox pick into the next time the editor was opened).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { EditableField } from './LeadDetailModern';
import { EC_PROJECT_TYPES } from '@/lib/projectTypes';

const SRC_PATH = path.join(__dirname, 'LeadDetailModern.jsx');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('root cause — loadData never lets an empty/missing settings response blank the canonical default', () => {
  it('REGRESSION: an empty projectTypes array from the composite detail endpoint is never treated as an override (Array.isArray + non-empty length check, not a bare truthiness check)', () => {
    expect(src).toMatch(/if \(Array\.isArray\(data\.projectTypes\) && data\.projectTypes\.length > 0\) pTypes = data\.projectTypes;/);
    // The old bare-truthiness check (`if (data.projectTypes) pTypes = ...`) —
    // which treats `[]` as a valid override — must not be present any more.
    expect(src).not.toMatch(/if \(data\.projectTypes\) pTypes = data\.projectTypes;/);
  });

  it('the Job Type field has its own belt-and-suspenders fallback to EC_PROJECT_TYPES at the call site, independent of the projectTypes state', () => {
    expect(src).toMatch(/options=\{projectTypes\.length > 0 \? projectTypes : EC_PROJECT_TYPES\}/);
  });

  it('projectTypes state is initialized to the canonical EC_PROJECT_TYPES constant, not an empty array', () => {
    expect(src).toMatch(/const \[projectTypes, setProjectTypes\] = useState\(DEFAULT_PROJECT_TYPES\);/);
    expect(src).toMatch(/const DEFAULT_PROJECT_TYPES = EC_PROJECT_TYPES;/);
  });

  it('updateField (backs the Job Type save) only ever calls railwayLeads.update — never a create/insert path, so saving Job Type can never duplicate the lead', () => {
    const fn = src.match(/const updateField = async[\s\S]*?\n  \};/)[0];
    expect(fn).toMatch(/railwayLeads\.update\(railwayId,/);
    expect(fn).not.toMatch(/railwayLeads\.create\(/);
    // On failure it reverts the optimistic update AND re-throws — so a
    // failed save can never look like a success to the caller.
    expect(fn).toMatch(/setLead\(prevLead\);\s*\n\s*throw e;/);
  });
});

describe('EditableField (multiselect) — the exact Job Type production repro', () => {
  it('REGRESSION: the full canonical EC_PROJECT_TYPES list renders — not an empty checkbox list', () => {
    render(
      <EditableField value={null} onSave={vi.fn()} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>—</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('—'));
    for (const type of EC_PROJECT_TYPES) {
      expect(screen.getByText(type)).toBeInTheDocument();
    }
  });

  it('pre-selects the lead\'s currently saved job type(s) (comma-separated string, the actual stored shape)', () => {
    render(
      <EditableField value="Kitchen Remodel, Roofing" onSave={vi.fn()} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>Kitchen Remodel, Roofing</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Kitchen Remodel, Roofing'));
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Demo' })).not.toBeChecked();
  });

  it('changing the selection and clicking Save calls onSave with the joined selection and exits edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(
      <EditableField value="Roofing" onSave={onSave} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>Roofing</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Roofing, Kitchen Remodel'));
    await waitFor(() => expect(screen.queryByText('Save')).not.toBeInTheDocument());
  });

  it('REGRESSION (reload): a fresh mount with the newly persisted value (exactly what a browser reload produces, since loadData fetches fresh and mounts the whole tree again) shows it pre-selected', () => {
    const { unmount } = render(
      <EditableField value="Roofing" onSave={vi.fn()} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>Roofing</span>
      </EditableField>
    );
    unmount();
    render(
      <EditableField value="Kitchen Remodel" onSave={vi.fn()} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>Kitchen Remodel</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Kitchen Remodel'));
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).not.toBeChecked();
  });

  it('Cancel does not call onSave and discards the unsaved selection (reopening shows the original value, not the abandoned pick)', () => {
    const onSave = vi.fn();
    render(
      <EditableField value="Roofing" onSave={onSave} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>Roofing</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen Remodel' }));
    fireEvent.click(screen.getByText('Cancel'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Roofing')).toBeInTheDocument(); // back to the read view

    fireEvent.click(screen.getByText('Roofing'));
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).not.toBeChecked();
  });

  it('a rejected save keeps the editor open and shows the error — never silently succeeds', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network error'));
    render(
      <EditableField value={null} onSave={onSave} type="multiselect" options={EC_PROJECT_TYPES} editable>
        <span>—</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('—'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Roofing' }));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('network error')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Roofing' })).toBeChecked();
  });

  it('an empty options list (the exact pre-fix production shape) renders no checkboxes — proving the OLD behavior and why the fix (canonical default + call-site fallback) is necessary', () => {
    render(
      <EditableField value={null} onSave={vi.fn()} type="multiselect" options={[]} editable>
        <span>—</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('—'));
    expect(screen.queryAllByRole('checkbox').length).toBe(0);
  });
});
