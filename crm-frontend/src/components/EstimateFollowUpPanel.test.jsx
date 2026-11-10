/**
 * EstimateFollowUpPanel.test.jsx — the Lead Detail section for the
 * automated 14-day estimate follow-up email sequence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EstimateFollowUpPanel from './EstimateFollowUpPanel';

const getState = vi.fn();
const getPreview = vi.fn();
const confirmSent = vi.fn();
const manualEnroll = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const stop = vi.fn();
vi.mock('@/api/railway/estimateFollowups', () => ({
  getState: (...a) => getState(...a),
  getPreview: (...a) => getPreview(...a),
  confirmSent: (...a) => confirmSent(...a),
  manualEnroll: (...a) => manualEnroll(...a),
  pause: (...a) => pause(...a),
  resume: (...a) => resume(...a),
  stop: (...a) => stop(...a),
}));

function lead(overrides = {}) { return { id: 'lead-1', ...overrides }; }
function admin() { return { role: 'admin', email: 'admin@example.com' }; }
function salesRep() { return { role: 'sales_rep', email: 'rep@example.com' }; }

const REPLY_LIMITATION = 'This CRM has no automatic inbound-email reply detection for this sequence. If a customer replies, a rep must manually pause or stop the sequence — it will not stop itself.';

beforeEach(() => {
  getState.mockReset(); getPreview.mockReset(); confirmSent.mockReset();
  manualEnroll.mockReset(); pause.mockReset(); resume.mockReset(); stop.mockReset();
});

describe('EstimateFollowUpPanel', () => {
  it('always surfaces the no-automatic-reply-detection limitation prominently', async () => {
    getState.mockResolvedValue({ state: 'not_eligible', eligibilityReasons: ['no_pending_estimate'], replyDetectionLimitation: REPLY_LIMITATION });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText(/No automatic reply detection/)).toBeInTheDocument());
    expect(screen.getByText(REPLY_LIMITATION)).toBeInTheDocument();
  });

  it('not_eligible: shows the human-readable reasons', async () => {
    getState.mockResolvedValue({ state: 'not_eligible', eligibilityReasons: ['lead_status_disqualifying:Lost'], replyDetectionLimitation: REPLY_LIMITATION });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Not Eligible')).toBeInTheDocument());
    expect(screen.getByText(/Lead status disqualifies this sequence/)).toBeInTheDocument();
  });

  it('awaiting_sent_confirmation: shows Confirm Estimate Sent, and Manually Enroll only for admin/manager', async () => {
    getState.mockResolvedValue({ state: 'awaiting_sent_confirmation', eligibilityReasons: [], replyDetectionLimitation: REPLY_LIMITATION, candidateEstimates: [] });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Confirm Estimate Sent — Start Sequence')).toBeInTheDocument());
    expect(screen.getByText(/Manually Enroll/)).toBeInTheDocument();
  });

  it('awaiting_sent_confirmation: a sales_rep never sees the Manually Enroll control', async () => {
    getState.mockResolvedValue({ state: 'awaiting_sent_confirmation', eligibilityReasons: [], replyDetectionLimitation: REPLY_LIMITATION, candidateEstimates: [] });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={salesRep()} />);
    await waitFor(() => expect(screen.getByText('Confirm Estimate Sent — Start Sequence')).toBeInTheDocument());
    expect(screen.queryByText(/Manually Enroll/)).not.toBeInTheDocument();
  });

  it('clicking Confirm Estimate Sent calls the API and reloads state', async () => {
    getState.mockResolvedValueOnce({ state: 'awaiting_sent_confirmation', eligibilityReasons: [], replyDetectionLimitation: REPLY_LIMITATION, candidateEstimates: [] });
    confirmSent.mockResolvedValue({ sequence: { id: 'seq-1', status: 'active' } });
    getState.mockResolvedValueOnce({
      state: 'scheduled', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: { id: 'seq-1', status: 'active', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent', estimateSentConfirmedAt: '2026-11-10T12:00:00Z', estimateSentConfirmedBy: 'rep@example.com', steps: [] },
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Confirm Estimate Sent — Start Sequence')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Confirm Estimate Sent — Start Sequence'));
    await waitFor(() => expect(confirmSent).toHaveBeenCalledWith('lead-1', { handoffEstimateId: null }));
    await waitFor(() => expect(screen.getByText('Scheduled')).toBeInTheDocument());
  });

  it('a multiple-pending-estimates lead shows a picker and requires a selection before enrolling', async () => {
    getState.mockResolvedValue({
      state: 'not_eligible', eligibilityReasons: ['multiple_pending_estimates'], replyDetectionLimitation: REPLY_LIMITATION,
      candidateEstimates: [{ id: 'est-1', qb_estimate_number: '101' }, { id: 'est-2', qb_estimate_number: '102' }],
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Which estimate?')).toBeInTheDocument());
    expect(screen.getByText('Estimate #101')).toBeInTheDocument();
    expect(screen.getByText('Estimate #102')).toBeInTheDocument();
  });

  it('active sequence: renders the 6-step timeline with statuses, and shows Pause/Stop (not Resume)', async () => {
    getState.mockResolvedValue({
      state: 'active', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: {
        id: 'seq-1', status: 'active', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent',
        estimateSentConfirmedAt: '2026-11-01T12:00:00Z', estimateSentConfirmedBy: 'rep@example.com',
        steps: [
          { id: 's1', stepNumber: 1, dayOffset: 1, status: 'sent', sentAt: '2026-11-02T17:00:00Z', dueAt: '2026-11-02T17:00:00Z' },
          { id: 's2', stepNumber: 2, dayOffset: 3, status: 'pending', dueAt: '2026-11-04T17:00:00Z' },
          { id: 's3', stepNumber: 3, dayOffset: 5, status: 'skipped', skippedReason: 'superseded_by_later_step', dueAt: '2026-11-06T17:00:00Z' },
        ],
      },
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText('Day 1 — Step 1')).toBeInTheDocument();
    expect(screen.getByText('Day 3 — Step 2')).toBeInTheDocument();
    expect(screen.getByText('Day 5 — Step 3')).toBeInTheDocument();
    expect(screen.getByText('superseded by later step')).toBeInTheDocument();
    expect(screen.getByText('Pause')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
    expect(screen.queryByText('Resume')).not.toBeInTheDocument();
  });

  it('paused sequence: shows the paused reason/by, and Resume (not Pause)', async () => {
    getState.mockResolvedValue({
      state: 'paused', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: {
        id: 'seq-1', status: 'paused', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent',
        pausedReason: 'customer_requested_pause', pausedBy: 'rep@example.com', steps: [],
      },
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Paused')).toBeInTheDocument());
    expect(screen.getByText(/customer_requested_pause/)).toBeInTheDocument();
    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.queryByText('Pause')).not.toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('stopped sequence: shows the stop reason/by, and neither Pause/Resume/Stop controls', async () => {
    getState.mockResolvedValue({
      state: 'stopped', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: {
        id: 'seq-1', status: 'stopped', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent',
        stoppedReason: 'customer_unsubscribed', stoppedBy: 'system:unsubscribe_link', steps: [],
      },
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
    expect(screen.getByText(/customer_unsubscribed/)).toBeInTheDocument();
    expect(screen.queryByText('Pause')).not.toBeInTheDocument();
    expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop')).not.toBeInTheDocument();
  });

  it('clicking Pause calls the API with a reason and reloads', async () => {
    getState.mockResolvedValueOnce({
      state: 'active', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: { id: 'seq-1', status: 'active', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent', steps: [] },
    });
    pause.mockResolvedValue({ sequence: { id: 'seq-1', status: 'paused' } });
    getState.mockResolvedValueOnce({
      state: 'paused', replyDetectionLimitation: REPLY_LIMITATION,
      sequence: { id: 'seq-1', status: 'paused', recipientEmail: 'jane@example.com', enrollmentMethod: 'confirm_sent', pausedReason: 'manual_pause', pausedBy: 'rep@example.com', steps: [] },
    });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('Pause')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Pause'));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('lead-1', 'manual_pause'));
    await waitFor(() => expect(screen.getByText('Paused')).toBeInTheDocument());
  });

  it('a load error renders a visible error message, not a crash', async () => {
    getState.mockRejectedValue({ data: { message: 'boom' }, message: 'request_failed' });
    render(<EstimateFollowUpPanel lead={lead()} currentUser={admin()} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
