/**
 * HandoffEstimatesPanel.test.jsx — regression coverage for the October 2026
 * production incident: this panel used to offer a SECOND "Sync from
 * Handoff" button that called the direct Handoff REST API
 * (POST /handoff/sync-estimates-for-lead), which always fails for this
 * installation with "EXTERNAL BLOCKER — OFFICIAL HANDOFF API KEY REQUIRED"
 * since EC has no Handoff API key and is not pursuing a direct Handoff API
 * connection (CLAUDE.md's "Handoff → QuickBooks → CRM estimate sync"
 * section). The panel's approved architecture is QB-only: estimates are
 * matched and ingested via the QuickBooks estimate sync cron / the
 * per-lead QB sync button, never a direct Handoff API call from here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import HandoffEstimatesPanel from './HandoffEstimatesPanel';

const listEstimates = vi.fn();
vi.mock('@/api/railway', () => ({
  handoffEstimates: { list: (...args) => listEstimates(...args) },
}));

const syncQBEstimatesForLead = vi.fn();
const diagnoseLeadEstimates = vi.fn();
const fetchEstimatePdf = vi.fn();
vi.mock('@/lib/railwayClient', () => ({
  syncQBEstimatesForLead: (...args) => syncQBEstimatesForLead(...args),
  diagnoseLeadEstimates: (...args) => diagnoseLeadEstimates(...args),
  fetchEstimatePdf: (...args) => fetchEstimatePdf(...args),
  normalizeIntegrationError: (e) => String(e?.message || e),
}));

const lead = { id: 'lead-1' };

beforeEach(() => {
  listEstimates.mockReset().mockResolvedValue({ items: [] });
  syncQBEstimatesForLead.mockReset().mockResolvedValue({ success: true });
  diagnoseLeadEstimates.mockReset();
  fetchEstimatePdf.mockReset();
  sessionStorage.clear();
});

describe('HandoffEstimatesPanel — no direct Handoff API dependency in the normal workflow', () => {
  it('never offers a "Sync from Handoff" control — only Diagnose and Sync from QuickBooks', async () => {
    render(<HandoffEstimatesPanel lead={lead} onLeadUpdate={vi.fn()} />);
    await waitFor(() => expect(listEstimates).toHaveBeenCalled());

    expect(screen.queryByTitle('Sync from Handoff')).toBeNull();
    expect(screen.getByTitle('Sync from QuickBooks')).toBeInTheDocument();
    expect(screen.getByTitle('Diagnose QB match')).toBeInTheDocument();
  });

  it('auto-sync on load calls only the QuickBooks sync path, never the Handoff API', async () => {
    render(<HandoffEstimatesPanel lead={lead} onLeadUpdate={vi.fn()} />);
    await waitFor(() => expect(syncQBEstimatesForLead).toHaveBeenCalledWith('lead-1'));
  });

  it('empty state ("No estimates yet") never shows an "EXTERNAL BLOCKER" / Handoff API key message', async () => {
    listEstimates.mockResolvedValue({ items: [] });
    render(<HandoffEstimatesPanel lead={lead} onLeadUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No estimates yet')).toBeInTheDocument());
    expect(screen.queryByText(/EXTERNAL BLOCKER/i)).toBeNull();
    expect(screen.queryByText(/HANDOFF_API_KEY/i)).toBeNull();
  });

  it('a lead with estimates already loaded from QuickBooks renders them without any Handoff API call', async () => {
    listEstimates.mockResolvedValue({
      items: [{
        id: 'est-1', qb_estimate_id: 'QB1', qb_estimate_number: 'EST-100',
        sync_source: 'QuickBooks', match_status: 'matched', estimate_amount: 5000,
        estimate_date: '2026-10-01', document_title: 'Kitchen Remodel Estimate',
      }],
    });
    render(<HandoffEstimatesPanel lead={lead} onLeadUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Kitchen Remodel Estimate')).toBeInTheDocument());
    expect(screen.getByText('EST-100')).toBeInTheDocument();
  });
});
