/**
 * MobileDayView.dateSync.test.jsx — PRODUCTION DEFECT 2 (My Day "Tomorrow"
 * does not drive the Daily Map, reported alongside the Jamey Corey Meeting
 * Follow-Up calendar defect). PERMANENT RULE: My Day's Today/Tomorrow/Next 7
 * Days selector must be authoritative for the embedded Daily Map — the map
 * must move to the selected day automatically and never retain a stale
 * prior-selection date.
 *
 * Mounts the REAL pages/MobileDayView.jsx with pages/DailyMap mocked (it has
 * its own full render coverage in DailyMap.test.jsx) so this file can assert
 * exactly what date/owner props MobileDayView threads into it as the date
 * filter pills are clicked — the actual production wiring bug (DailyMap was
 * rendered with zero props) lived in that prop-threading, not inside
 * DailyMap.jsx itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileDayView from './MobileDayView';

const dailyMapProps = [];
vi.mock('@/pages/DailyMap', () => ({
  default: (props) => { dailyMapProps.push(props); return <div data-testid="daily-map-stub">stub</div>; },
  fmt12: (t) => t,
  OWNER_COLORS: { Unassigned: { bg: '#000', text: 'white', label: 'Unassigned' } },
}));

const listLeads = vi.fn();
vi.mock('@/api/railway/leads', () => ({
  list: (...args) => listLeads(...args),
}));

let mockUser = { role: 'admin', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function getTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getTomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function leadFixture(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Jamey', last_name: 'Corey', status: 'Active',
    property_address: '1 Main St', city: 'Los Angeles', assigned_rep: 'Yaron Drilevich',
    appointment_date: null, appointment_type: null, appointment_time: null,
    follow_up_type: null, follow_up_date: null, follow_up_time: null, follow_up_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  dailyMapProps.length = 0;
  listLeads.mockReset();
  mockUser = { role: 'admin', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich' };
});

async function renderMyDay() {
  const utils = render(
    <MemoryRouter initialEntries={['/my-day']}>
      <MobileDayView />
    </MemoryRouter>
  );
  // The header (and date pills) render once the initial lead fetch resolves,
  // regardless of whether that day has any appointments — unlike the map
  // stub, which only mounts when there is at least one.
  await screen.findByText('My Day');
  return utils;
}

describe('MobileDayView → DailyMap date threading (PERMANENT RULE)', () => {
  it('Today (default): Daily Map receives today\'s date', async () => {
    listLeads.mockResolvedValue({ items: [leadFixture({ appointment_date: getTodayLocal(), appointment_time: '09:00', appointment_type: 'Meeting' })] });
    await renderMyDay();
    await screen.findByTestId('daily-map-stub');
    const last = dailyMapProps[dailyMapProps.length - 1];
    expect(last.date).toBe(getTodayLocal());
    expect(last.hideDatePicker).toBe(true);
  });

  it('Tomorrow: Daily Map automatically moves to tomorrow\'s date — never the stale today date', async () => {
    listLeads.mockResolvedValue({ items: [leadFixture({ appointment_date: getTomorrowLocal(), appointment_time: '12:00', appointment_type: 'Meeting' })] });
    await renderMyDay();
    fireEvent.click(screen.getByText('Tomorrow'));
    await screen.findByTestId('daily-map-stub');
    await waitFor(() => {
      const last = dailyMapProps[dailyMapProps.length - 1];
      expect(last.date).toBe(getTomorrowLocal());
    });
    const last = dailyMapProps[dailyMapProps.length - 1];
    expect(last.date).not.toBe(getTodayLocal());
    expect(last.hideDatePicker).toBe(true);
  });

  it('switching Tomorrow → Today moves the map back to today (no stale retention either direction)', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({ id: 'l-today', appointment_date: getTodayLocal(), appointment_time: '09:00', appointment_type: 'Meeting' }),
      leadFixture({ id: 'l-tomorrow', appointment_date: getTomorrowLocal(), appointment_time: '09:00', appointment_type: 'Meeting' }),
    ] });
    await renderMyDay();
    fireEvent.click(screen.getByText('Tomorrow'));
    await waitFor(() => expect(dailyMapProps[dailyMapProps.length - 1].date).toBe(getTomorrowLocal()));
    fireEvent.click(screen.getByText('Today'));
    await waitFor(() => expect(dailyMapProps[dailyMapProps.length - 1].date).toBe(getTodayLocal()));
  });

  it('Next 7 Days: defaults to a clear single day (today) within the period and exposes Daily Map\'s own date picker rather than silently showing an unrelated stale date', async () => {
    listLeads.mockResolvedValue({ items: [leadFixture({ appointment_date: getTodayLocal(), appointment_time: '09:00', appointment_type: 'Meeting' })] });
    await renderMyDay();
    fireEvent.click(screen.getByText('Next 7 Days'));
    await screen.findByTestId('daily-map-stub');
    await waitFor(() => {
      const last = dailyMapProps[dailyMapProps.length - 1];
      expect(last.date).toBe(getTodayLocal());
      expect(last.hideDatePicker).toBe(false);
    });
  });

  it('owner filter selected in My Day\'s rep pills is threaded into the embedded Daily Map (filters stay consistent across List/Map)', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({ id: 'l1', assigned_rep: 'Yaron Drilevich', appointment_date: getTodayLocal(), appointment_time: '09:00', appointment_type: 'Meeting' }),
      leadFixture({ id: 'l2', assigned_rep: 'Ethan Magen', appointment_date: getTodayLocal(), appointment_time: '10:00', appointment_type: 'Meeting' }),
    ] });
    await renderMyDay();
    await screen.findByTestId('daily-map-stub');
    await waitFor(() => expect(screen.queryByText('Yaron')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Yaron'));
    await waitFor(() => expect(dailyMapProps[dailyMapProps.length - 1].ownerFilter).toBe('Yaron Drilevich'));
  });
});

describe('MobileDayView — canonical PHYSICAL MEETING data semantics (List view / counts)', () => {
  it('an active Meeting Follow-Up (no appointment) counts and renders as a physical meeting for the selected day', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({ follow_up_type: 'Meeting', follow_up_date: getTodayLocal(), follow_up_time: '12:00', follow_up_status: 'pending' }),
    ] });
    await renderMyDay();
    fireEvent.click(screen.getByText('List'));
    await waitFor(() => expect(screen.getByText(/1 appointment/)).toBeInTheDocument());
  });

  it('a completed Meeting Follow-Up is never counted as a physical meeting', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({ follow_up_type: 'Meeting', follow_up_date: getTodayLocal(), follow_up_time: '12:00', follow_up_status: 'completed' }),
    ] });
    await renderMyDay();
    fireEvent.click(screen.getByText('List'));
    await waitFor(() => expect(screen.getByText(/No meetings scheduled for today/)).toBeInTheDocument());
  });

  it('a Phone Call follow-up is never counted as a physical meeting / route stop', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({ follow_up_type: 'Phone Call', follow_up_date: getTodayLocal(), follow_up_time: '12:00', follow_up_status: 'pending' }),
    ] });
    await renderMyDay();
    fireEvent.click(screen.getByText('List'));
    await waitFor(() => expect(screen.getByText(/No meetings scheduled for today/)).toBeInTheDocument());
  });

  it('mirror-dedup (PR #8 principle): a lead with BOTH a real Appointment and an exact-mirror Meeting Follow-Up counts ONCE, not twice', async () => {
    listLeads.mockResolvedValue({ items: [
      leadFixture({
        appointment_date: getTodayLocal(), appointment_time: '12:00', appointment_type: 'Meeting',
        follow_up_type: 'Meeting', follow_up_date: getTodayLocal(), follow_up_time: '12:00', follow_up_status: 'pending',
      }),
    ] });
    await renderMyDay();
    fireEvent.click(screen.getByText('List'));
    await waitFor(() => expect(screen.getByText(/1 appointment/)).toBeInTheDocument());
  });
});
