/**
 * MeetingFollowUp.test.jsx — Lead Detail → Follow-Up / Next Update → Type
 * "Meeting".
 *
 * A 'Meeting' follow-up is STILL ONLY A FOLLOW-UP RECORD (an internal next
 * action, leads.follow_up_*). It can be selected and saved through
 * PUT /:id/follow-up, survives a reload, and never becomes an `appointments`
 * row in the UI: no appointment API call from this form, no customer
 * appointment reminder (that stays appointment-only), no driving stop from
 * Lead Detail itself.
 *
 * UPDATED (post-Jamey-Corey production defect, PERMANENT RULE): an ACTIVE
 * Meeting Follow-Up now gets real physical-meeting SCHEDULING SEMANTICS on
 * the backend (blocks availability, 1h duration, Driving/Travel Time, one
 * calendar meeting representation — see lib/booking/followUpMeeting.js) and
 * My Day (pages/MobileDayView.jsx) is the one frontend surface that reflects
 * this in its own schedule/count/map, via its own candidate-building logic
 * (isAppointmentSupersededForDay + a per-lead candidates loop — mirrors the
 * backend's lib/booking/currentAction.js, PERMANENT RULE: an active
 * Meeting-type Follow-Up supersedes a same-day Appointment, even at a
 * different time — see test/currentAction.test.js and
 * MobileDayView.dateSync.test.jsx's Muhammad Khan/Jamey Corey/Mario Ibanez
 * cases). This does not change anything this file asserts: Lead Detail's
 * own Follow-Up form still never calls the appointment API or syncs the
 * calendar directly, and `syncCalendar`/`updateAppointment` still go
 * uncalled when saving a Meeting follow-up — see the "No frontend path
 * converts a Meeting follow-up into an appointment" describe block below
 * for MobileDayView.jsx's narrow, documented carve-out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import FollowUpScheduler from './FollowUpScheduler';
import AppointmentReminderPanel from './AppointmentReminderPanel';
import TestReminderPanel from './TestReminderPanel';

const updateAppointment = vi.fn();
const updateFollowUp = vi.fn();
const syncCalendar = vi.fn();
vi.mock('@/api/railway', () => ({
  leads: {
    updateAppointment: (...a) => updateAppointment(...a),
    updateFollowUp: (...a) => updateFollowUp(...a),
    syncCalendar: (...a) => syncCalendar(...a),
  },
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'admin@ecconstructiongroup.com', role: 'admin' } }),
}));

function lead(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Brian', last_name: 'Krantz', email: 'b@x.com', assigned_rep: 'Yaron Drilevich',
    appointment: null, appointment_date: null, appointment_time: null, appointment_type: null,
    follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_notes: null, follow_up_status: null,
    ...overrides,
  };
}
const MEETING_FU = { follow_up_date: '2031-05-01', follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_status: 'pending' };

beforeEach(() => {
  [updateAppointment, updateFollowUp, syncCalendar].forEach(f => f.mockReset());
});

describe('Follow-Up type "Meeting"', () => {
  it('the Type dropdown offers Phone Call, Text, Email, Meeting and Other', () => {
    render(<FollowUpScheduler lead={lead()} onLeadUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText('Add'));
    const options = [...screen.getByLabelText('Follow-up type').options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['Phone Call', 'Text', 'Email', 'Meeting', 'Other']);
  });

  it('Meeting can be selected and saved — through PUT /:id/follow-up only, never the appointment API', async () => {
    const onLeadUpdate = vi.fn();
    updateFollowUp.mockResolvedValue({ lead: lead(MEETING_FU) });
    render(<FollowUpScheduler lead={lead()} onLeadUpdate={onLeadUpdate} />);
    fireEvent.click(screen.getByText('Add'));
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2031-05-01' } });
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '11:00' } });
    fireEvent.change(screen.getByLabelText('Follow-up type'), { target: { value: 'Meeting' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateFollowUp).toHaveBeenCalledTimes(1));
    expect(updateFollowUp.mock.calls[0][1]).toEqual({
      follow_up_date: '2031-05-01', follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_notes: null, follow_up_status: 'pending',
    });
    expect(updateAppointment).not.toHaveBeenCalled();
    expect(syncCalendar).not.toHaveBeenCalled();
    await waitFor(() => expect(onLeadUpdate).toHaveBeenCalledWith(expect.objectContaining({ follow_up_type: 'Meeting' })));
  });

  it('reload preserves Meeting (display + edit form)', () => {
    render(<FollowUpScheduler lead={lead(MEETING_FU)} onLeadUpdate={vi.fn()} />);
    expect(screen.getByText('Meeting')).toBeInTheDocument();
    expect(screen.getByTestId('follow-up-when')).toHaveTextContent('May 1, 2031 • 11:00 AM');
    expect(screen.queryByText(/Google Calendar/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Follow-up type')).toHaveValue('Meeting');
  });

  it('a Meeting follow-up never shows the customer appointment reminder panel', () => {
    const { container } = render(<AppointmentReminderPanel lead={lead({ follow_up_date: '2099-05-01', follow_up_time: '11:00', follow_up_type: 'Meeting' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the reminder panel follows the real appointment, not the follow-up', () => {
    render(<AppointmentReminderPanel lead={lead({
      appointment_date: '2099-06-02', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2099-05-01', follow_up_time: '11:00', follow_up_type: 'Meeting',
    })} />);
    expect(screen.getAllByText(/Jun 2, 2099/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/May 1, 2099/)).not.toBeInTheDocument();
  });

  it('Test Appointment Reminder refuses a lead that only has a Meeting follow-up', () => {
    render(<TestReminderPanel lead={lead(MEETING_FU)} onClose={vi.fn()} />);
    expect(screen.getByText('Cannot Send Test')).toBeInTheDocument();
    expect(screen.getByText('This lead must have a scheduled appointment with a date and time.')).toBeInTheDocument();
  });
});

// Source guard: calendar / reminder / routing code must never read a
// follow-up as an appointment. Only display-only widgets may look at a
// Meeting follow-up's type (icon/colour).
describe('No frontend path converts a Meeting follow-up into an appointment', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const DISPLAY_ONLY = new Set([
    'components/FollowUpsWidget.jsx', // bucket colour/icon for the follow-up entry
    'pages/LeadsModern.jsx',          // row badge
    'pages/OverdueLeads.jsx',         // icon
  ]);
  // PERMANENT RULE (post-Jamey-Corey production defect): the canonical
  // PHYSICAL MEETING is a real Appointment Meeting OR an active Meeting-type
  // Follow-Up (lib/booking/followUpMeeting.js on the backend). My Day is the
  // one frontend surface that must apply this SAME canonical definition (for
  // its schedule/count/map), so it is a deliberate SECOND physical-meeting
  // source — not a display-only badge, and not a fallback FROM the
  // appointment (see the dedicated it() below, which proves it never does
  // `appointment_date || follow_up_date`-style fallback; the Appointment
  // branch is always checked and returned first).
  const PHYSICAL_MEETING_SOURCE = new Set(['pages/MobileDayView.jsx']);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) files.push(p);
    }
  })(SRC);

  it('only display-only files and the My Day physical-meeting source compare follow_up_type to "Meeting"', () => {
    const offenders = files
      .filter(f => /follow_up_type\s*[!=]==?\s*['"]Meeting['"]/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f).split(path.sep).join('/'))
      .filter(f => !DISPLAY_ONLY.has(f) && !PHYSICAL_MEETING_SOURCE.has(f));
    expect(offenders).toEqual([]);
  });

  it.each([
    'components/GoogleSyncTab.jsx',
    'components/CalendarSyncMonitor.jsx',
    'components/AppointmentReminderPanel.jsx',
    'components/TestReminderPanel.jsx',
    'components/ReminderHealthPanel.jsx',
    'components/MeetingPipelineAudit.jsx',
  ])('%s never falls back from the appointment to the follow-up', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).not.toMatch(/appointment_(date|time)\s*\|\|\s*[\w.]*follow_up_/);
    expect(src).not.toMatch(/follow_up_type\s*===?\s*['"]Meeting['"]/);
  });

  it('pages/MobileDayView.jsx never falls back from appointment fields to follow-up fields (it checks each candidate independently, it never ORs the two)', () => {
    const src = fs.readFileSync(path.join(SRC, 'pages/MobileDayView.jsx'), 'utf8');
    expect(src).not.toMatch(/appointment_(date|time)\s*\|\|\s*[\w.]*follow_up_/);
    const supersededMatch = src.match(/const isAppointmentSupersededForDay = \(l, day\) =>[\s\S]*?;/);
    expect(supersededMatch, 'isAppointmentSupersededForDay() helper must exist (mirrors lib/booking/currentAction.js)').toBeTruthy();
    expect(supersededMatch[0]).toMatch(/l\.appointment_date/);
    expect(supersededMatch[0]).toMatch(/l\.follow_up_type === "Meeting"/);
  });
});
