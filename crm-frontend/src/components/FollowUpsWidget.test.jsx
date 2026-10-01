/**
 * FollowUpsWidget.test.jsx — Today's Work card-identity/isolation regression
 * coverage (production defect: two cards rendered for the same lead were
 * reported as "duplicates", and completing one follow-up appeared to make
 * an unrelated appointment card disappear too).
 *
 * Domain model under test (see lib/booking/appointmentView.js and
 * CLAUDE.md's "Appointment vs Follow-Up" invariant):
 *   - the APPOINTMENT and the FOLLOW-UP are separate canonical entities;
 *   - a lead may legitimately have one, the other, both, or neither;
 *   - completing/clearing one must never remove the other from the render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FollowUpsWidget from './FollowUpsWidget';

const updateFollowUp = vi.fn();
vi.mock('@/api/railway/leads', () => ({
  updateFollowUp: (...a) => updateFollowUp(...a),
}));

function renderWidget(props) {
  return render(<MemoryRouter><FollowUpsWidget {...props} /></MemoryRouter>);
}

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function tomorrowStr() {
  const n = new Date();
  n.setDate(n.getDate() + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function baseLead(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Jann', last_name: 'Ziegenhohn', status: 'New',
    appointment_date: null, appointment_time: null, appointment_type: null,
    follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  updateFollowUp.mockReset();
});

describe('FollowUpsWidget — Today\'s Work card identity', () => {
  it('a lead with ONLY a real appointment renders exactly one card, labeled Appointment', () => {
    const lead = baseLead({ appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Appointment · Meeting/);
  });

  it('a lead with ONLY a Meeting follow-up renders exactly one card, labeled Follow-up', () => {
    const lead = baseLead({ follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Follow-up · Meeting/);
  });

  it('REGRESSION (Muhammad Khan, production): an active Meeting Follow-Up supersedes a same-day Appointment at a DIFFERENT time — renders ONLY the Follow-Up, not both', () => {
    // Production report: Dashboard showed "Appointment · Meeting · 9:00 AM"
    // AND "Follow-up · Meeting · 10:00 AM" as two separate current-work
    // items. They are not an exact-time mirror, yet the Follow-Up is still
    // the one authoritative current action (AUTHORITATIVE CURRENT-ACTION
    // RULE) — the stale 9:00 AM Appointment must not also appear.
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Follow-up · Meeting/);
  });

  it('REGRESSION (Roger Dayan, exact-time case, still correct under the broader rule): an exact date/time match also renders ONE card — the Follow-Up wins', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '16:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Follow-up · Meeting/);
  });

  it('a same-day Meeting Follow-Up carrying its own notes STILL supersedes the Appointment (notes are not a factor in the authoritative-next-action rule)', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
      follow_up_notes: 'Also confirm they received the revised estimate',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Follow-up · Meeting/);
  });

  it('REGRESSION (Jamey Corey shape, preserved): an Appointment and an active Follow-Up on genuinely DIFFERENT days both still appear, each on its own day — never merged, never superseded', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: tomorrowStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    // Appointment shows under Today's Work (not superseded — the Follow-Up is dated a different day)...
    expect(screen.getAllByText(/Appointment · Meeting/)).toHaveLength(1);
    // ...and the independent future Follow-Up shows under Tomorrow — both present.
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);
    expect(screen.getByText('Tomorrow')).toBeTruthy();
  });

  it('REGRESSION (Mario Ibanez shape): a lead with ONLY a current Appointment and no superseding Follow-Up renders the Appointment as current work', () => {
    const lead = baseLead({ appointment_date: todayStr(), appointment_time: '14:00', appointment_type: 'Meeting' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Appointment · Meeting/);
  });

  it('a same-day Phone Call/Text/Email/Other Follow-Up never supersedes the Appointment — both are genuinely independent and both render', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '08:00', follow_up_type: 'Phone Call', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Appointment · Meeting/)).toHaveLength(1);
    expect(screen.getAllByText(/Follow-up · Phone Call/)).toHaveLength(1);
  });

  it('completing a superseding Follow-Up reveals the previously-hidden same-day Appointment (supersession lifecycle)', async () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '14:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    updateFollowUp.mockResolvedValue({ lead: { ...lead, follow_up_status: 'completed' } });

    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    // Only the Follow-Up shows initially — the Appointment is superseded.
    let badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toMatch(/Follow-up · Meeting/);

    const completeBtn = screen.getByTitle('Mark follow-up done');
    fireEvent.click(completeBtn);

    await waitFor(() => {
      const remaining = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].textContent).toMatch(/Appointment · Meeting/);
    });

    // The API call that ran was the follow-up-only endpoint — never an
    // appointment cancel/delete call, and it carried only the follow-up
    // status field, never appointment fields. The Appointment record itself
    // was never touched — it simply stopped being superseded.
    expect(updateFollowUp).toHaveBeenCalledTimes(1);
    expect(updateFollowUp).toHaveBeenCalledWith('lead-1', { follow_up_status: 'completed' });
  });

  it('a Phone Call follow-up (no Meeting) still renders exactly one card, correctly labeled a Call not a Meeting', () => {
    const lead = baseLead({ follow_up_date: todayStr(), follow_up_time: '09:00', follow_up_type: 'Phone Call', follow_up_status: 'pending' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getByText(/Follow-up · Phone Call/)).toBeTruthy();
    expect(screen.queryByText(/Meeting/)).toBeFalsy();
  });
});
