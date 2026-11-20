/**
 * MeetingFollowUp.test.jsx — Lead Detail → Follow-Up / Next Update → Type
 * "Meeting".
 *
 * PRODUCT CORRECTION (November 2026, supersedes the "STILL ONLY A FOLLOW-UP
 * RECORD" framing this file's header used to open with): the Follow-Up
 * fields are now the single, user-facing source of scheduling truth for a
 * Meeting. Saving a dated Meeting Follow-Up now automatically creates or
 * reschedules the real `appointments` row, its Google Calendar main+travel
 * events, and reminders — see lib/booking/followUpAppointmentSync.js
 * (backend) and the "John John" production incident it was built to fix
 * permanently. Crucially, this sync is a SERVER-SIDE side effect of
 * PUT /:id/follow-up, never a second, separate frontend API call — this
 * file's own assertions that `updateAppointment`/`syncCalendar` are never
 * called directly BY THIS COMPONENT remain true and unchanged below; the
 * component still only ever calls `updateFollowUp`. FollowUpScheduler.jsx
 * itself still never becomes a physical-meeting scheduling engine (no
 * availability/blocking/conflict logic lives here) — it only renders the
 * server's reported sync outcome (created/rescheduled/cancelled/error) and
 * a residual mismatch notice for the one case the server deliberately
 * leaves untouched (see the component's own header). It is therefore added
 * to this file's own DISPLAY_ONLY guard set below as a legitimate,
 * documented exception — showing informational help text about automatic
 * syncing, never appointment-affecting logic of its own.
 *
 * Everything else this file predates is unchanged: an active Meeting
 * Follow-Up ALSO still gets real physical-meeting scheduling semantics via
 * the separate, pre-existing lib/booking/followUpMeeting.js mechanism
 * (blocks availability, Driving/Travel Time, My Day) — that mechanism and
 * this correction are complementary, not in tension: one is "what does a
 * Meeting Follow-Up occupy on the calendar/schedule" (followUpMeeting.js,
 * unchanged), the other is "what does editing the Follow-Up do to the
 * canonical `appointments` row" (followUpAppointmentSync.js, new).
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

  it('reload preserves Meeting (display + edit form) — and now explicitly tells the user it keeps Google Calendar in sync (November 2026 correction, supersedes the old "no mention of Google Calendar" assertion)', () => {
    render(<FollowUpScheduler lead={lead(MEETING_FU)} onLeadUpdate={vi.fn()} />);
    expect(screen.getByText('Meeting')).toBeInTheDocument();
    expect(screen.getByTestId('follow-up-when')).toHaveTextContent('May 1, 2031 • 11:00 AM');
    expect(screen.getByText(/Google Calendar/)).toBeInTheDocument();
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
    // November 2026 PRODUCT CORRECTION: shows a different, purely
    // informational help line for Meeting (vs. every other type) and
    // renders the server's own reported sync outcome
    // (created/rescheduled/cancelled/error) + the residual mismatch
    // notice. It never calls the appointment API itself, never computes
    // availability/blocking/conflict logic, and never decides scheduling
    // outcomes — the real decision and every write happen server-side in
    // lib/booking/followUpAppointmentSync.js, triggered by the SAME
    // PUT /:id/follow-up call this component already made before this
    // correction. See the component's own header and this file's header.
    'components/FollowUpScheduler.jsx',
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

  it('pages/MobileDayView.jsx derives current physical meetings ENTIRELY from the Follow-Up — it never reads appointment_date/appointment_time at all for current-work selection (FINAL RULE: no Appointment fallback)', () => {
    const src = fs.readFileSync(path.join(SRC, 'pages/MobileDayView.jsx'), 'utf8');
    expect(src).not.toMatch(/appointment_(date|time)\s*\|\|\s*[\w.]*follow_up_/);
    const predicateMatch = src.match(/export function isCurrentPhysicalMeetingForDay\(l, day\) \{[\s\S]*?\n\}/);
    expect(predicateMatch, 'isCurrentPhysicalMeetingForDay() helper must exist (mirrors lib/booking/currentAction.js — see MobileDayView.currentActionParity.test.jsx)').toBeTruthy();
    expect(predicateMatch[0]).not.toMatch(/appointment_date|appointment_time|appointment_type/);
    expect(predicateMatch[0]).toMatch(/l\.follow_up_type === "Meeting"/);
  });
});
