/**
 * FollowUpsWidget.test.jsx — Today's Work card-identity/isolation regression
 * coverage, now under the FINAL AUTHORITATIVE CURRENT-ACTION RULE
 * (post-Muhammad-Khan/Jamey-Corey/Mario-Ibanez production correction, see
 * lib/booking/currentAction.js and CLAUDE.md's "Appointment vs Follow-Up"
 * invariant): current work is derived ENTIRELY from the Follow-Up / Next
 * Update. The Appointment is historical/reference data only and is NEVER a
 * fallback source of current work — not even when the lead has no active
 * Follow-Up at all. Every rendered current-work card is therefore always
 * labeled "Follow-up · <type>" — there is no "Appointment · <type>" badge
 * anywhere in this component any more.
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

describe('FollowUpsWidget — Today\'s Work card identity (FINAL RULE: Follow-Up only, no Appointment fallback)', () => {
  it('REGRESSION (Mario Ibanez shape): a lead with ONLY a current Appointment and NO Follow-Up renders NO current-work card at all', () => {
    const lead = baseLead({ appointment_date: todayStr(), appointment_time: '14:00', appointment_type: 'Meeting' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.queryByText("Today's Work")).toBeFalsy();
    expect(screen.queryByText(/Follow-up ·/)).toBeFalsy();
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();
  });

  it('a lead with ONLY a Meeting follow-up renders exactly one card, labeled Follow-up', () => {
    const lead = baseLead({ follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Follow-up · Meeting/);
    expect(badges).toHaveLength(1);
  });

  it('REGRESSION (Muhammad Khan, production): an Appointment 9:00 AM + an active Meeting Follow-Up 10:00 AM — renders ONLY the Follow-Up, never the Appointment', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();
  });

  it('an exact date/time match between Appointment and Follow-Up also renders ONE card — the Follow-Up, never a mirror check', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '16:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();
  });

  it('a same-day Meeting Follow-Up carrying its own notes still renders as the ONLY current-work card', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
      follow_up_notes: 'Also confirm they received the revised estimate',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);
  });

  it('REGRESSION (Jamey Corey shape): a historical Appointment today + an active Follow-Up tomorrow — ONLY the Follow-Up shows, under Tomorrow; the Appointment never appears as current work today', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: tomorrowStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.queryByText("Today's Work")).toBeFalsy();
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);
    expect(screen.getByText('Tomorrow')).toBeTruthy();
  });

  it('a same-day Phone Call/Text/Email/Other Follow-Up renders as the ONLY current-work card — the Appointment never appears alongside it', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '08:00', follow_up_type: 'Phone Call', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Follow-up · Phone Call/)).toHaveLength(1);
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();
  });

  it('the Appointment date/time still appears as reference info on the Follow-Up card ("Appt: ..."), never as its own current-work entry', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getByText(/Appt:/)).toBeTruthy();
  });

  it('completing the active Follow-Up removes the lead from current work entirely — the Appointment never fills in (no fallback lifecycle)', async () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '14:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    updateFollowUp.mockResolvedValue({ lead: { ...lead, follow_up_status: 'completed' } });

    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Follow-up · Meeting/)).toHaveLength(1);

    const completeBtn = screen.getByTitle('Mark follow-up done');
    fireEvent.click(completeBtn);

    await waitFor(() => {
      expect(screen.queryByText("Today's Work")).toBeFalsy();
    });
    expect(screen.queryByText(/Follow-up ·/)).toBeFalsy();
    expect(screen.queryByText(/Appointment ·/)).toBeFalsy();

    // The API call that ran was the follow-up-only endpoint — never an
    // appointment cancel/delete call, and it carried only the follow-up
    // status field. The Appointment record itself was never touched.
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
