/**
 * LeadDetailModern.ownerChange.test.jsx — regression coverage for the
 * production defect: changing a Lead's Owner turned the entire Lead Detail
 * page into a blank white screen (URL unchanged, no error, no way back
 * except a manual reload).
 *
 * ROOT CAUSE: routes/leads.js's GET /by-external/:externalRef/detail returns
 * contactOwners as [{id, display_name, email}, ...] (real objects), but
 * LeadDetailModern.jsx passed that array directly as EditableField's
 * `options` for the Owner field. EditableField's select/multiselect render
 * each option as `{o}` — a raw JSX child — and React throws "Objects are not
 * valid as a React child" the moment that field is opened for editing. With
 * no error boundary anywhere above Lead Detail, that uncaught render error
 * unmounted the ENTIRE page.
 *
 * FIX: (1) map contactOwners to plain display_name strings at the one call
 * site that needs them as selectable text: `contactOwners.map(o =>
 * o.display_name)`. (2) Hardened EditableField itself (normalizeOptionLabel)
 * so ANY future caller passing object options degrades gracefully instead of
 * crashing. (3) Wrapped LeadDetailModern in an ErrorBoundary so a future
 * unrelated render error shows a recoverable fallback, never a blank page.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { EditableField, normalizeOptionLabel } from './LeadDetailModern';
import ErrorBoundary from '../components/ErrorBoundary';

const SRC = path.join(__dirname, '..');

describe('normalizeOptionLabel — never returns a non-primitive', () => {
  it('passes through strings and numbers', () => {
    expect(normalizeOptionLabel('Yaron Drilevich')).toBe('Yaron Drilevich');
    expect(normalizeOptionLabel(42)).toBe('42');
  });
  it('extracts display_name from an owner-shaped object (the exact production shape)', () => {
    expect(normalizeOptionLabel({ id: 'o1', display_name: 'Michelle Roitman Drilevich', email: 'michelle@ecconstructiongroup.com' })).toBe('Michelle Roitman Drilevich');
  });
  it('falls back to label/name/value for other object shapes', () => {
    expect(normalizeOptionLabel({ label: 'Foo' })).toBe('Foo');
    expect(normalizeOptionLabel({ name: 'Bar' })).toBe('Bar');
    expect(normalizeOptionLabel({ value: 'Baz' })).toBe('Baz');
  });
  it('null/undefined/empty-object become an empty string, never a crash', () => {
    expect(normalizeOptionLabel(null)).toBe('');
    expect(normalizeOptionLabel(undefined)).toBe('');
    expect(normalizeOptionLabel({})).toBe('');
  });
});

describe('EditableField (select) — the exact production repro', () => {
  it('THE BUG: rendering raw owner OBJECTS as options no longer throws (used to crash the whole page)', async () => {
    const onSave = vi.fn().mockResolvedValue();
    const contactOwnersRaw = [
      { id: 'o1', display_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com' },
      { id: 'o2', display_name: 'Michelle Roitman Drilevich', email: 'michelle@ecconstructiongroup.com' },
    ];
    // Passing the RAW object array directly — exactly the pre-fix production
    // call site — must not throw during render.
    expect(() => render(
      <EditableField value="Yaron Drilevich" onSave={onSave} type="select" options={contactOwnersRaw} editable>
        <span>Yaron Drilevich</span>
      </EditableField>
    )).not.toThrow();

    fireEvent.click(screen.getByText('Yaron Drilevich'));
    // Both display names render as real, selectable option text.
    expect(screen.getByText('Michelle Roitman Drilevich')).toBeInTheDocument();
  });

  it('successful owner change: exits edit mode and shows the new value — the page stays rendered', async () => {
    const onSave = vi.fn().mockResolvedValue();
    const { rerender } = render(
      <EditableField value="—" onSave={onSave} type="select" options={['Yaron Drilevich', 'Michelle Roitman Drilevich']} editable>
        <span>Unassigned</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Unassigned'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Michelle Roitman Drilevich' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Michelle Roitman Drilevich'));
    // Exits edit mode on success — the select/Save/Cancel UI is gone, proving
    // the component (and by extension the page) is still mounted and rendering.
    await waitFor(() => expect(screen.queryByText('Save')).not.toBeInTheDocument());
    rerender(
      <EditableField value="Michelle Roitman Drilevich" onSave={onSave} type="select" options={['Yaron Drilevich', 'Michelle Roitman Drilevich']} editable>
        <span>Michelle Roitman Drilevich</span>
      </EditableField>
    );
    expect(screen.getByText('Michelle Roitman Drilevich')).toBeInTheDocument();
  });

  it('a failed/malformed API response produces an inline error state, not a crash', async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(
      <EditableField value="Yaron Drilevich" onSave={onSave} type="select" options={['Yaron Drilevich', 'Michelle Roitman Drilevich']} editable>
        <span>Yaron Drilevich</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Yaron Drilevich'));
    fireEvent.click(screen.getByText('Save'));
    // Stays in edit mode, shows the error — never unmounts / goes blank.
    expect(await screen.findByText('forbidden')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('null/missing owner (no assigned_rep yet) renders "Unassigned" safely, no crash', () => {
    expect(() => render(
      <EditableField value={null} onSave={vi.fn()} type="select" options={[{ id: 'o1', display_name: 'Yaron Drilevich' }]} editable>
        <span>Unassigned</span>
      </EditableField>
    )).not.toThrow();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('an owner list containing a malformed entry (no display_name) is filtered out, not rendered blank/crashed', () => {
    const malformed = [{ id: 'o1', display_name: 'Yaron Drilevich' }, { id: 'o2' }, null];
    render(
      <EditableField value="—" onSave={vi.fn()} type="select" options={malformed} editable>
        <span>Unassigned</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('Unassigned'));
    const opts = screen.getAllByRole('option').map(o => o.textContent);
    expect(opts).toContain('Yaron Drilevich');
    expect(opts.filter(t => t === '')).toEqual([]); // no blank options from the malformed entries
  });
});

describe('ErrorBoundary — a render crash never leaves a permanently blank page', () => {
  function Boom() { throw new Error('simulated render crash'); }
  it('catches a render error and shows a recoverable fallback instead of unmounting to nothing', () => {
    const { container } = render(<ErrorBoundary name="test"><Boom /></ErrorBoundary>);
    expect(container.textContent).not.toBe('');
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('clears itself when resetKey changes (navigating to a different lead is never stuck)', () => {
    const { rerender } = render(<ErrorBoundary name="test" resetKey="lead-1"><Boom /></ErrorBoundary>);
    expect(screen.getByText('Try again')).toBeInTheDocument();
    rerender(<ErrorBoundary name="test" resetKey="lead-2"><span>Lead 2 loaded fine</span></ErrorBoundary>);
    expect(screen.getByText('Lead 2 loaded fine')).toBeInTheDocument();
  });
});

describe('horizontal audit — source guards', () => {
  const src = fs.readFileSync(path.join(SRC, 'pages', 'LeadDetailModern.jsx'), 'utf8');

  it('the Owner field never passes the raw contactOwners object array as options', () => {
    expect(src).toMatch(/options=\{contactOwners\.map\(o => o\.display_name\)/);
  });

  it('LeadDetailModern (default export) is wrapped in ErrorBoundary', () => {
    expect(src).toMatch(/<ErrorBoundary[\s\S]*?<LeadDetailModernInner/);
  });

  it('updateField (used by the Owner field and every other inline mutation) only ever calls railwayLeads.update — never a create/insert path, so a mutation can never duplicate the lead', () => {
    const fn = src.match(/const updateField = async[\s\S]*?\n  \};/)[0];
    expect(fn).toMatch(/railwayLeads\.update\(/);
    expect(fn).not.toMatch(/railwayLeads\.create\(/);
  });
});
