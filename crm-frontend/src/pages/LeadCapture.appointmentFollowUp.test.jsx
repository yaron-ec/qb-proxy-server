/**
 * LeadCapture.appointmentFollowUp.test.jsx — New Lead supports the two
 * independent concepts:
 *   A. Appointment / site visit (optional) → appointment_date/time/type
 *   B. Follow-up / next update (optional)  → follow_up_date/time/type/notes
 * The payload never derives one from the other (the old form copied nothing
 * but the backend mirrored the appointment into follow_up_* — the root of
 * "Appointment: Not set" next to "Follow-up: Meeting …" in Lead Detail).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LeadCapture from './LeadCapture';

const submitCapture = vi.fn();
const fetchCaptureAvailability = vi.fn();
vi.mock('@/lib/captureRailwayClient', () => ({
  submitCapture: (...a) => submitCapture(...a),
  fetchCaptureAvailability: (...a) => fetchCaptureAvailability(...a),
  fetchAppLists: () => Promise.resolve({ projectTypes: [], leadSources: [] }),
}));
vi.mock('@/lib/fileUpload', () => ({ uploadFileToStorage: vi.fn() }));
const AUTH = { user: null };
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => AUTH }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

beforeEach(() => {
  submitCapture.mockReset();
  submitCapture.mockResolvedValue({ success: true, lead: { id: 'l1', first_name: 'Jane', last_name: 'Smith' }, appointment: null, follow_up: null });
  fetchCaptureAvailability.mockReset();
  fetchCaptureAvailability.mockResolvedValue({ blocked_slots: [] });
});

function fillRequired(container) {
  fireEvent.change(container.querySelector('input[placeholder="Jane"]'), { target: { value: 'Jane' } });
  fireEvent.change(container.querySelector('input[placeholder="Smith"]'), { target: { value: 'Smith' } });
  fireEvent.change(container.querySelector('input[type="tel"]'), { target: { value: '3105550000' } });
  fireEvent.click(container.querySelector('input[type="checkbox"]'));
  const sourceSelect = [...container.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'Referral'));
  fireEvent.change(sourceSelect, { target: { value: 'Referral' } });
}
const dateInputs = (c) => c.querySelectorAll('input[type="date"]'); // [0]=appointment, [1]=follow-up
const followUpTypeSelect = (c) => [...c.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'Text'));
const submit = () => fireEvent.click(screen.getByText('Submit Lead to CRM'));

describe('New Lead — Appointment and Follow-Up are independent', () => {
  it('renders both sections, both optional', () => {
    render(<LeadCapture />);
    expect(screen.getByText('Appointment / Site Visit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Follow-Up / Next Update (optional)')).toBeInTheDocument();
  });

  it('neither: submits a plain lead (no appointment, no follow-up)', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    submit();
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    const p = submitCapture.mock.calls[0][0];
    expect(p.appointment_date).toBeNull();
    expect(p.appointment_time).toBeNull();
    expect(p.follow_up_date).toBeNull();
    expect(p.follow_up_type).toBeNull();
  });

  it('follow-up only: sends follow_up_* and no appointment', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    fireEvent.change(dateInputs(container)[1], { target: { value: '2031-03-02' } });
    fireEvent.change(container.querySelector('input[type="time"]'), { target: { value: '10:15' } });
    fireEvent.change(followUpTypeSelect(container), { target: { value: 'Phone Call' } });
    fireEvent.change(container.querySelector('textarea[placeholder="What should happen next?"]'), { target: { value: 'Call back re: budget' } });
    submit();
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    const p = submitCapture.mock.calls[0][0];
    expect(p).toMatchObject({
      appointment_date: null, appointment_time: null,
      follow_up_date: '2031-03-02', follow_up_time: '10:15', follow_up_type: 'Phone Call', follow_up_notes: 'Call back re: budget',
    });
  });

  it('follow-up type Meeting: offered, sent as a follow-up only, never as an appointment', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    const options = [...followUpTypeSelect(container).options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['Phone Call', 'Text', 'Email', 'Meeting', 'Other']);
    fireEvent.change(dateInputs(container)[1], { target: { value: '2031-03-03' } });
    fireEvent.change(container.querySelector('input[type="time"]'), { target: { value: '11:00' } });
    fireEvent.change(followUpTypeSelect(container), { target: { value: 'Meeting' } });
    submit();
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    const p = submitCapture.mock.calls[0][0];
    expect(p).toMatchObject({
      appointment_date: null, appointment_time: null, appointment_type: null,
      follow_up_date: '2031-03-03', follow_up_time: '11:00', follow_up_type: 'Meeting',
    });
  });

  it('both: appointment and follow-up are sent separately, never copied into each other', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    fireEvent.change(dateInputs(container)[0], { target: { value: '2031-02-10' } });
    await waitFor(() => expect(screen.getByText('4:00 PM')).toBeInTheDocument());
    fireEvent.click(screen.getByText('4:00 PM'));
    fireEvent.change(dateInputs(container)[1], { target: { value: '2031-04-10' } });
    fireEvent.change(followUpTypeSelect(container), { target: { value: 'Text' } });
    submit();
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    const p = submitCapture.mock.calls[0][0];
    expect(p).toMatchObject({
      appointment_date: '2031-02-10', appointment_time: '16:00', appointment_type: 'Meeting',
      follow_up_date: '2031-04-10', follow_up_type: 'Text',
    });
  });

  it('appointment only: no follow-up fields are derived from the appointment', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    fireEvent.change(dateInputs(container)[0], { target: { value: '2031-02-11' } });
    await waitFor(() => expect(screen.getByText('9:00 AM')).toBeInTheDocument());
    fireEvent.click(screen.getByText('9:00 AM'));
    submit();
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    const p = submitCapture.mock.calls[0][0];
    expect(p.appointment_date).toBe('2031-02-11');
    expect(p.follow_up_date).toBeNull();
    expect(p.follow_up_type).toBeNull();
  });

  it('an incomplete follow-up or an appointment date without a time blocks submit with a visible error', async () => {
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    fireEvent.change(dateInputs(container)[1], { target: { value: '2031-03-02' } }); // no type
    fireEvent.change(dateInputs(container)[0], { target: { value: '2031-02-12' } }); // no time
    submit();
    expect(await screen.findAllByText('Required for a follow-up')).toHaveLength(1);
    expect(screen.getByText('Pick a time, or clear the date')).toBeInTheDocument();
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it('a server validation error is shown, not swallowed', async () => {
    submitCapture.mockRejectedValue(Object.assign(new Error('follow_up_type must be one of: Phone Call, Text, Email, Meeting, Other'),
      { status: 400, data: { error: 'validation_failed', message: 'follow_up_type must be one of: Phone Call, Text, Email, Meeting, Other' } }));
    const { container } = render(<LeadCapture />);
    fillRequired(container);
    submit();
    expect(await screen.findByText(/follow_up_type must be one of/)).toBeInTheDocument();
  });
});
