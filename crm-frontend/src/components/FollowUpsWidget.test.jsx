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

  it('a lead with a real Appointment AND a genuinely independent Follow-Up (different note/content) renders two distinct cards', () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    const badges = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
    // Two distinct rendered entries — one per canonical entity, per the
    // documented "a lead can legitimately appear once for each" behavior.
    expect(badges).toHaveLength(2);
    const labels = badges.map((b) => b.textContent);
    expect(labels.some((t) => t.includes('Appointment · Meeting'))).toBe(true);
    expect(labels.some((t) => t.includes('Follow-up · Meeting'))).toBe(true);
  });

  it('completing the Follow-Up removes ONLY the Follow-Up card — the Appointment card remains, in the same render pass', async () => {
    const lead = baseLead({
      appointment_date: todayStr(), appointment_time: '12:00', appointment_type: 'Meeting',
      follow_up_date: todayStr(), follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    });
    updateFollowUp.mockResolvedValue({ lead: { ...lead, follow_up_status: 'completed' } });

    renderWidget({ leads: [lead], allLeads: [lead], deals: [] });
    expect(screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/)).toHaveLength(2);

    const completeBtn = screen.getByTitle('Mark follow-up done');
    fireEvent.click(completeBtn);

    await waitFor(() => {
      const remaining = screen.getAllByText(/Appointment · Meeting|Follow-up · Meeting/);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].textContent).toMatch(/Appointment · Meeting/);
    });

    // The API call that ran was the follow-up-only endpoint — never an
    // appointment cancel/delete call, and it carried only the follow-up
    // status field, never appointment fields.
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
