/**
 * LeadDetailModern.invalidIdFix.test.jsx — regression coverage for the
 * production defect: on Lead Detail for an existing, valid lead (Charles
 * Carlson), changing Status to "Lost" and clicking Save produced
 * `invalid_id`.
 *
 * ROOT CAUSE: backend PUT /api/v1/leads/:id has always correctly required
 * the real Railway UUID (`lead.id`) — that's intentional, it's the only
 * update path that can never duplicate a lead (see routes/leads.js's
 * UPDATABLE_FIELDS comment). The bug was in this file: `onLeadUpdate` was
 * wired directly to the raw `setLead` state setter and handed to ~9
 * sibling panels (HandoffEstimatesPanel, DealsPanel, PartialInvoiceFlow,
 * SignNowPanel, CalendarSyncPanel, GoogleContactSyncPanel, ProposalPanel,
 * MobileIntegrationActions, LeftSidebarContent). Every lead-returning
 * backend response includes `.id` (the canonical UUID), but the legacy
 * `.railway_id` convenience alias was only ever stamped once, right after
 * the initial load. Any sibling panel calling onLeadUpdate(res.lead) with
 * a raw, unstamped response silently wiped `railway_id` from state. The
 * NEXT Status/field save then fell back to the raw URL param — which can
 * legitimately be a non-UUID external_ref for a lead opened via its
 * legacy identifier — producing `invalid_id` against a perfectly valid,
 * existing lead.
 *
 * FIX: a single `setLeadSafe` wrapper (re-stamps railway_id = id on every
 * update) now backs every `onLeadUpdate` prop, plus defense-in-depth
 * fallback reordering (`lead.id` always preferred) at every direct
 * railwayLeads.update/remove call site in this file.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { EditableField } from './LeadDetailModern';

const SRC_PATH = path.join(__dirname, 'LeadDetailModern.jsx');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('horizontal audit — every sibling panel is wired to setLeadSafe, never the raw setLead setter', () => {
  it('setLeadSafe exists and re-stamps railway_id = id on every update (so it can never go stale again)', () => {
    const fn = src.match(/const setLeadSafe = \(updater\) => \{[\s\S]*?\n  \};/)[0];
    expect(fn).toMatch(/if \(next && next\.id\) next\.railway_id = next\.id;/);
  });

  it('zero remaining call sites pass the raw setLead setter as onLeadUpdate', () => {
    expect(src).not.toMatch(/onLeadUpdate=\{setLead\}/);
  });

  it('every top-level onLeadUpdate prop is backed by setLeadSafe (sub-components like LeftSidebarContent legitimately forward the prop onward as onLeadUpdate={onLeadUpdate} — that is not a new raw setLead reference, just passing the already-safe function down)', () => {
    const matches = src.match(/onLeadUpdate=\{[^}]+\}/g) || [];
    const topLevel = matches.filter(m => m !== 'onLeadUpdate={onLeadUpdate}');
    expect(topLevel.length).toBeGreaterThan(5); // sanity: many sibling panels wire this prop
    for (const m of topLevel) {
      expect(m).toBe('onLeadUpdate={setLeadSafe}');
    }
    // And the forwarded prop always resolves back to setLeadSafe, never a fresh raw setLead.
    expect(matches).toContain('onLeadUpdate={onLeadUpdate}');
  });
});

describe('horizontal audit — every direct railwayLeads.update/remove call site prefers lead.id (the always-present canonical UUID) over the legacy railway_id alias', () => {
  it('updateField (backs Status and every other inline-editable field) resolves railwayId as lead.id || lead.railway_id || id', () => {
    const fn = src.match(/const updateField = async[\s\S]*?\n  \};/)[0];
    expect(fn).toMatch(/const railwayId = lead\?\.id \|\| lead\?\.railway_id \|\| id;/);
    expect(fn).toMatch(/railwayLeads\.update\(railwayId,/);
    expect(fn).not.toMatch(/railwayLeads\.create\(/);
  });

  it('the Status field is wired through updateField (the fixed, canonical path) — not a separate/divergent status handler', () => {
    expect(src).toMatch(/value=\{lead\.status \|\| "New"\} onSave=\{v => updateField\("status", v\)\}/);
  });

  it('STATUSES includes "Lost" — the exact status from the production repro', () => {
    const statuses = src.match(/const STATUSES = \[([^\]]+)\];/)[1];
    expect(statuses).toMatch(/"Lost"/);
  });

  it('handleDeleteLead prefers lead.id first', () => {
    expect(src).toMatch(/await railwayLeads\.remove\(lead\.id \|\| lead\.railway_id \|\| id\);/);
  });

  it('EditNameButton\'s save prefers lead.id first', () => {
    expect(src).toMatch(/railwayLeads\.update\(lead\.id \|\| lead\.railway_id, \{ first_name: first, last_name: last \}\)/);
  });

  it('the new-intake-marker clear (loadData) prefers leadData.id first', () => {
    expect(src).toMatch(/railwayLeads\.update\(leadData\.id \|\| leadData\.railway_id \|\| id, \{ is_new_intake_lead: false/);
  });
});

describe('horizontal audit — sibling child components hardened to prefer lead.id over the legacy railway_id alias', () => {
  const componentsDir = path.join(__dirname, '..', 'components');
  function read(name) { return fs.readFileSync(path.join(componentsDir, name), 'utf8'); }

  it('ActivityComposer.jsx: railwayLeadId, idempotencyKey, and task lead_id all prefer lead.id', () => {
    const c = read('ActivityComposer.jsx');
    expect(c).toMatch(/let railwayLeadId = lead\.id \|\| lead\.railway_id;/);
    expect(c).toMatch(/const idempotencyKey = `activity-composer:\$\{lead\.id \|\| lead\.railway_id\}/);
    expect(c).toMatch(/lead_id: lead\.id \|\| lead\.railway_id,/);
  });

  it('AttachmentsPanel.jsx: a single leadId derivation prefers lead.id, used for both list() and upload create()', () => {
    const c = read('AttachmentsPanel.jsx');
    expect(c).toMatch(/const leadId = lead\?\.id \|\| lead\?\.railway_id;/);
    expect(c).toMatch(/railwayLeadAttachments\.list\(\{ lead_id: leadId \}\)/);
    expect(c).toMatch(/lead_id: leadId,/);
  });

  it('PartialInvoiceFlow.jsx: invoice list params prefer lead.id', () => {
    const c = read('PartialInvoiceFlow.jsx');
    expect(c).toMatch(/const params = \{ lead_id: lead\.id \|\| lead\.railway_id \};/);
  });
});

describe('EditableField (select) — Status change behavioral repro (New → Lost)', () => {
  it('changing Status to Lost calls onSave with the new status and exits edit mode — no crash, no blank page', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(
      <EditableField value="New" onSave={onSave} type="select" options={['New', 'Lost', 'Sold']} editable showPencil={false}>
        <span>New</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('New'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Lost' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Lost'));
    await waitFor(() => expect(screen.queryByText('Save')).not.toBeInTheDocument());
  });

  it('a real invalid_id backend rejection surfaces an inline, readable error — never a blank/crashed page', async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('invalid_id'), { status: 400 }));
    render(
      <EditableField value="New" onSave={onSave} type="select" options={['New', 'Lost']} editable showPencil={false}>
        <span>New</span>
      </EditableField>
    );
    fireEvent.click(screen.getByText('New'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Lost' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('invalid_id')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});
