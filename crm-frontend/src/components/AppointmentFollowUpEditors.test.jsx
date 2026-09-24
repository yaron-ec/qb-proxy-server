/**
 * AppointmentFollowUpEditors.test.jsx — Lead Detail → Schedule.
 *
 * AppointmentEditor reads lead.appointment (the canonical appointments row)
 * and writes ONLY PUT /:id/appointment. FollowUpScheduler reads follow_up_*
 * and writes ONLY PUT /:id/follow-up. Neither touches the other, errors are
 * surfaced, and calendar status comes from the appointment and resolves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AppointmentEditor from './AppointmentEditor';
import FollowUpScheduler from './FollowUpScheduler';

const updateAppointment = vi.fn();
const updateFollowUp = vi.fn();
const syncCalendar = vi.fn();
const getLead = vi.fn();
vi.mock('@/api/railway', () => ({
  leads: {
    updateAppointment: (...a) => updateAppointment(...a),
    updateFollowUp: (...a) => updateFollowUp(...a),
    syncCalendar: (...a) => syncCalendar(...a),
    get: (...a) => getLead(...a),
  },
}));
const AUTH = { user: { email: 'rep@ecconstructiongroup.com', role: 'sales_rep' } };
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => AUTH }));
vi.mock('@/lib/ownerEmailMap', () => ({ resolveOwnerEmail: () => 'yaron@ecconstructiongroup.com' }));
vi.mock('@/lib/calendarAvailability', () => ({ validateSlot: () => Promise.resolve({ blocked: false }) }));
vi.mock('@/components/AvailableTimePicker', () => ({
  default: ({ value, onChange }) => <input aria-label="Appointment time" value={value} onChange={e => onChange(e.target.value)} />,
}));

const APPT = {
  id: 'appt-1', date: '2026-09-24', time: '16:00', end_time: '17:00', kind: 'Meeting', status: 'scheduled',
  calendar_sync_status: 'synced', calendar_last_error: null, google_event_id: 'ev1',
};
function lead(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Brian', last_name: 'Krantz', email: 'b@x.com', assigned_rep: 'Yaron Drilevich',
    appointment: null, appointment_date: null, appointment_time: null,
    follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_notes: null, follow_up_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  [updateAppointment, updateFollowUp, syncCalendar, getLead].forEach(f => f.mockReset());
});

describe('AppointmentEditor', () => {
  it('shows "Not set" when there is no appointment — even if a Meeting follow-up exists', () => {
    render(<AppointmentEditor lead={lead({ follow_up_date: '2026-09-24', follow_up_time: '16:00', follow_up_type: 'Meeting' })} onLeadUpdate={vi.fn()} />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('shows the canonical appointment and its calendar state', () => {
    render(<AppointmentEditor lead={lead({ appointment: APPT, appointment_date: APPT.date, appointment_time: APPT.time })} onLeadUpdate={vi.fn()} />);
    expect(screen.getByTestId('appointment-when')).toHaveTextContent('Sep 24, 2026 • 4:00 PM–5:00 PM');
    expect(screen.getByText('✓ Synced to Google Calendar')).toBeInTheDocument();
  });

  it('creates an appointment through PUT /:id/appointment only (never the follow-up API)', async () => {
    const onLeadUpdate = vi.fn();
    updateAppointment.mockResolvedValue({ lead: lead({ appointment: { ...APPT, calendar_sync_status: 'synced' } }) });
    const { container } = render(<AppointmentEditor lead={lead()} onLeadUpdate={onLeadUpdate} />);
    fireEvent.click(screen.getByText('Schedule'));
    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2031-02-10' } });
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '16:00' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAppointment).toHaveBeenCalledTimes(1));
    expect(updateAppointment.mock.calls[0][0]).toBe('lead-1');
    expect(updateAppointment.mock.calls[0][1]).toMatchObject({
      appointment_date: '2031-02-10', appointment_time: '16:00', appointment_type: 'Meeting', expected_appointment_id: null,
    });
    expect(updateFollowUp).not.toHaveBeenCalled();
    await waitFor(() => expect(onLeadUpdate).toHaveBeenCalled());
  });

  it('reschedules with the current appointment id and can switch to Phone Call', async () => {
    updateAppointment.mockResolvedValue({ lead: lead() });
    const { container } = render(<AppointmentEditor lead={lead({ appointment: APPT })} onLeadUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Phone Call'));
    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-09-25' } });
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(updateAppointment).toHaveBeenCalled());
    expect(updateAppointment.mock.calls[0][1]).toMatchObject({
      appointment_date: '2026-09-25', appointment_time: '16:00', appointment_type: 'Phone Call', expected_appointment_id: 'appt-1',
    });
  });

  it('surfaces a server conflict (409) instead of failing silently', async () => {
    updateAppointment.mockRejectedValue(Object.assign(new Error('x'), { status: 409, data: { error: 'slot_conflict', message: 'This time conflicts with another appointment (including the 1-hour travel buffer).' } }));
    render(<AppointmentEditor lead={lead({ appointment: APPT })} onLeadUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Update'));
    expect(await screen.findByText(/conflicts with another appointment/)).toBeInTheDocument();
  });

  it('a failed calendar sync shows the worker error and a working Retry', async () => {
    syncCalendar.mockResolvedValue({ success: true });
    getLead.mockResolvedValue({ lead: lead({ appointment: { ...APPT, calendar_sync_status: 'pending' } }) });
    const onLeadUpdate = vi.fn();
    render(<AppointmentEditor lead={lead({ appointment: { ...APPT, calendar_sync_status: 'failed', calendar_last_error: 'Calendar create 403: forbidden' } })} onLeadUpdate={onLeadUpdate} />);
    expect(screen.getByText(/Calendar sync failed: Calendar create 403: forbidden/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry sync'));
    await waitFor(() => expect(syncCalendar).toHaveBeenCalledWith('lead-1'));
    await waitFor(() => expect(onLeadUpdate).toHaveBeenCalled());
  });

  it('"Syncing…" only while pending; retrying shows the error text', () => {
    const { rerender } = render(<AppointmentEditor lead={lead({ appointment: { ...APPT, calendar_sync_status: 'pending' } })} onLeadUpdate={vi.fn()} />);
    expect(screen.getByText(/Syncing to Google Calendar/)).toBeInTheDocument();
    rerender(<AppointmentEditor lead={lead({ appointment: { ...APPT, calendar_sync_status: 'retrying', calendar_last_error: '500 backendError' } })} onLeadUpdate={vi.fn()} />);
    expect(screen.queryByText(/Syncing to Google Calendar/)).not.toBeInTheDocument();
    expect(screen.getByText(/retrying automatically: 500 backendError/)).toBeInTheDocument();
  });
});

describe('FollowUpScheduler (follow-up only)', () => {
  it('shows the follow-up with notes and never the appointment', () => {
    render(<FollowUpScheduler lead={lead({ appointment: APPT, follow_up_date: '2031-04-10', follow_up_time: '09:30', follow_up_type: 'Text', follow_up_notes: 'Send proposal link' })} onLeadUpdate={vi.fn()} />);
    expect(screen.getByTestId('follow-up-when')).toHaveTextContent('Apr 10, 2031 • 9:30 AM');
    expect(screen.getByText('Send proposal link')).toBeInTheDocument();
    expect(screen.queryByText(/Google Calendar/)).not.toBeInTheDocument();
  });

  it('saves date/time/type/notes through PUT /:id/follow-up only', async () => {
    const onLeadUpdate = vi.fn();
    updateFollowUp.mockResolvedValue({ lead: lead({ follow_up_date: '2031-05-01' }) });
    render(<FollowUpScheduler lead={lead()} onLeadUpdate={onLeadUpdate} />);
    fireEvent.click(screen.getByText('Add'));
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2031-05-01' } });
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '11:45' } });
    fireEvent.change(screen.getByLabelText('Follow-up type'), { target: { value: 'Email' } });
    fireEvent.change(screen.getByLabelText('Follow-up notes'), { target: { value: 'Revised' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateFollowUp).toHaveBeenCalledTimes(1));
    expect(updateFollowUp.mock.calls[0][1]).toEqual({
      follow_up_date: '2031-05-01', follow_up_time: '11:45', follow_up_type: 'Email', follow_up_notes: 'Revised', follow_up_status: 'pending',
    });
    expect(updateAppointment).not.toHaveBeenCalled();
    await waitFor(() => expect(onLeadUpdate).toHaveBeenCalled());
  });

  it('mark done sends a status-only update', async () => {
    updateFollowUp.mockResolvedValue({ lead: lead() });
    render(<FollowUpScheduler lead={lead({ follow_up_date: '2031-04-10', follow_up_type: 'Text' })} onLeadUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText('Mark done'));
    await waitFor(() => expect(updateFollowUp).toHaveBeenCalledWith('lead-1', { follow_up_status: 'completed' }, expect.anything()));
  });

  it('surfaces a save failure', async () => {
    updateFollowUp.mockRejectedValue(Object.assign(new Error('x'), { status: 400, data: { message: 'follow_up_date must be a valid YYYY-MM-DD date' } }));
    render(<FollowUpScheduler lead={lead({ follow_up_date: '2031-04-10', follow_up_type: 'Text' })} onLeadUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Update'));
    expect(await screen.findByText('follow_up_date must be a valid YYYY-MM-DD date')).toBeInTheDocument();
  });
});
