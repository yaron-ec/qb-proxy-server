/**
 * EstimateFollowUps.test.jsx — admin/manager-only global oversight page
 * for the automated 14-day estimate follow-up email sequence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EstimateFollowUps from './EstimateFollowUps';

function renderPage() {
  return render(<MemoryRouter><EstimateFollowUps /></MemoryRouter>);
}

let meUser = { role: 'admin' };
vi.mock('@/lib/railwayApi', () => ({ me: () => Promise.resolve({ user: meUser }) }));

const getAdminOverview = vi.fn();
const getDryRunReport = vi.fn();
const listTemplates = vi.fn();
const getTemplateHistory = vi.fn();
const saveTemplate = vi.fn();
vi.mock('@/api/railway/estimateFollowups', () => ({
  getAdminOverview: (...a) => getAdminOverview(...a),
  getDryRunReport: (...a) => getDryRunReport(...a),
  listTemplates: (...a) => listTemplates(...a),
  getTemplateHistory: (...a) => getTemplateHistory(...a),
  saveTemplate: (...a) => saveTemplate(...a),
}));

beforeEach(() => {
  meUser = { role: 'admin' };
  getAdminOverview.mockReset();
  getDryRunReport.mockReset();
  listTemplates.mockReset();
  getTemplateHistory.mockReset();
  saveTemplate.mockReset();
  getAdminOverview.mockResolvedValue({ counts: { active: 2, paused: 1, completed: 0, stopped: 1 }, total: 4, sequences: [] });
  getDryRunReport.mockResolvedValue({ generated_at: '2026-11-10T00:00:00Z', by_state: {}, total: 0, leads: [] });
  listTemplates.mockResolvedValue({
    templates: [
      { stepNumber: 1, dayOffset: 1, templateKey: 'day1', template: { version: 1, subject: 'Just checking in about your estimate', body_html: '<p>Hi {{first_name}}</p>' } },
      { stepNumber: 2, dayOffset: 3, templateKey: 'day3', template: { version: 1, subject: 'Any questions about your project?', body_html: '<p>Hi again</p>' } },
    ],
  });
});

describe('EstimateFollowUps page — role gating', () => {
  it('a sales_rep is blocked with an explanatory message, and no admin API is ever called', async () => {
    meUser = { role: 'sales_rep' };
    renderPage();
    await waitFor(() => expect(screen.getByText('Admins and Managers Only')).toBeInTheDocument());
    expect(getAdminOverview).not.toHaveBeenCalled();
  });

  it('an admin sees the overview with state counts', async () => {
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  });

  it('a manager is also allowed in (not admin-only)', async () => {
    meUser = { role: 'manager' };
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    expect(screen.queryByText('Admins and Managers Only')).not.toBeInTheDocument();
  });
});

describe('EstimateFollowUps page — overview tab', () => {
  it('renders the sequences table with lead links', async () => {
    getAdminOverview.mockResolvedValue({
      counts: { active: 1 }, total: 1,
      sequences: [{ leadId: 'lead-1', leadName: 'Jane Doe', status: 'active', recipientEmail: 'jane@example.com', salesRepName: 'Bob Rep', createdAt: '2026-11-01T00:00:00Z', sentCount: 2, failedCount: 0 }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('Bob Rep')).toBeInTheDocument();
  });

  it('shows a failed count in red when > 0', async () => {
    getAdminOverview.mockResolvedValue({
      counts: {}, total: 1,
      sequences: [{ leadId: 'lead-1', leadName: 'Jane Doe', status: 'active', recipientEmail: 'jane@example.com', createdAt: '2026-11-01T00:00:00Z', sentCount: 1, failedCount: 2 }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  });
});

describe('EstimateFollowUps page — dry-run report tab', () => {
  it('never calls the report until "Run Report" is clicked', async () => {
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Dry-Run Report'));
    expect(getDryRunReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Run Report'));
    await waitFor(() => expect(getDryRunReport).toHaveBeenCalled());
  });

  it('renders by-state counts and the leads table', async () => {
    getDryRunReport.mockResolvedValue({
      generated_at: '2026-11-10T00:00:00Z',
      by_state: { eligible_awaiting_sent_confirmation: 1, not_eligible: 1 },
      total: 2,
      leads: [
        { lead_id: 'lead-1', estimate_id: 'est-1', qb_estimate_number: '101', state: 'eligible_awaiting_sent_confirmation', reasons: [] },
        { lead_id: 'lead-2', estimate_id: 'est-2', qb_estimate_number: '102', state: 'not_eligible', reasons: ['lead_status_disqualifying:Lost'] },
      ],
    });
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Dry-Run Report'));
    fireEvent.click(screen.getByText('Run Report'));
    await waitFor(() => expect(screen.getByText('101')).toBeInTheDocument());
    expect(screen.getByText('102')).toBeInTheDocument();
    expect(screen.getByText(/lead_status_disqualifying:Lost/)).toBeInTheDocument();
  });
});

describe('EstimateFollowUps page — template editor tab', () => {
  it('lists all templates and loads the first one\'s subject/body by default', async () => {
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Templates'));
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByDisplayValue('Just checking in about your estimate')).toBeInTheDocument());
  });

  it('admin can edit and save a new version', async () => {
    saveTemplate.mockResolvedValue({ template: { template_key: 'day1', version: 2 } });
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Templates'));
    await waitFor(() => expect(screen.getByDisplayValue('Just checking in about your estimate')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Just checking in about your estimate'), { target: { value: 'New subject' } });
    fireEvent.click(screen.getByText('Save as New Version'));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledWith('day1', { subject: 'New subject', bodyHtml: '<p>Hi {{first_name}}</p>' }));
  });

  it('a manager (non-admin) sees disabled fields and no Save button', async () => {
    meUser = { role: 'manager' };
    renderPage();
    await waitFor(() => expect(getAdminOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Templates'));
    await waitFor(() => expect(screen.getByDisplayValue('Just checking in about your estimate')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Just checking in about your estimate')).toBeDisabled();
    expect(screen.queryByText('Save as New Version')).not.toBeInTheDocument();
    expect(screen.getByText(/Template editing is admin-only/)).toBeInTheDocument();
  });
});
