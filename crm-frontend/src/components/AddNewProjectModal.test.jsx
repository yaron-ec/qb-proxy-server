/**
 * AddNewProjectModal.test.jsx — horizontal-consistency regression coverage.
 *
 * This modal used to default to its own hardcoded DEFAULT_JOB_TYPES list,
 * diverging from the canonical lib/projectTypes.js#EC_PROJECT_TYPES vocabulary
 * in both casing and membership (e.g. "Kitchen remodel" vs "Kitchen Remodel",
 * "Doors" which isn't a canonical type at all). It now defaults to
 * EC_PROJECT_TYPES, matching every other Project Type editor in the CRM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AddNewProjectModal from './AddNewProjectModal';
import { EC_PROJECT_TYPES } from '@/lib/projectTypes';

const getSetting = vi.fn();
vi.mock('@/api/railway/settings', () => ({
  get: (...args) => getSetting(...args),
}));
vi.mock('@/api/railway/deals', () => ({ create: vi.fn() }));

beforeEach(() => { getSetting.mockReset(); });

function renderModal() {
  return render(
    <MemoryRouter>
      <AddNewProjectModal lead={{ id: 'lead-1' }} currentDeal={null} onClose={vi.fn()} onSuccess={vi.fn()} />
    </MemoryRouter>
  );
}

describe('AddNewProjectModal — Job Type options use the canonical EC_PROJECT_TYPES vocabulary', () => {
  it('shows the full canonical list by default (before any Settings fetch resolves)', () => {
    getSetting.mockReturnValue(new Promise(() => {})); // never resolves
    renderModal();
    for (const type of EC_PROJECT_TYPES) {
      expect(screen.getByRole('checkbox', { name: type })).toBeInTheDocument();
    }
  });

  it('REGRESSION: never shows the old non-canonical values ("Kitchen remodel" lowercase, "Doors")', () => {
    getSetting.mockRejectedValue(new Error('forbidden'));
    renderModal();
    expect(screen.queryByText('Kitchen remodel')).toBeNull();
    expect(screen.queryByText('Doors')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Kitchen Remodel' })).toBeInTheDocument();
  });

  it('a successful Settings fetch with a non-empty list overrides the canonical default', async () => {
    getSetting.mockResolvedValue({ value: { projectTypes: ['Custom Job Type'] } });
    renderModal();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Custom Job Type' })).toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: 'Roofing' })).toBeNull();
  });
});
