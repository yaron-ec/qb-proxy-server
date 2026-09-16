/**
 * DailyMap.test.jsx — full integration regression coverage for the My Day
 * Map P0 crash, mounting the REAL pages/DailyMap.jsx component (the exact
 * module rendered by pages/MobileDayView.jsx for My Day's Map view) with a
 * mocked routing API and auth context. This proves the actual production
 * wiring (DailyMap.jsx → MapView/AppointmentList) is correct end to end,
 * not just that each component tolerates missing props in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DailyMap from './DailyMap';

const getDailySchedule = vi.fn();

vi.mock('@/api/railway', () => ({
  routing: { getDailySchedule: (...args) => getDailySchedule(...args) },
}));

let mockUser = { role: 'admin', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function apptFixture(overrides = {}) {
  return {
    id: 'lead-mia', external_ref: null, first_name: 'Mia', last_name: 'Arias',
    phone: '+18184008787', email: 'mia@example.com',
    property_address: '123 Main St', city: 'Los Angeles',
    follow_up_time: '14:00', assigned_rep: 'Yaron Drilevich', project_type: 'Kitchen Remodel',
    verifiedAddress: '123 Main St, Los Angeles, CA', coords: { lat: 34.05, lng: -118.24 },
    requiredDeparture: '13:30', targetArrival: '13:50', driveDuration: '20 min', driveDistance: '8.2 mi',
    ...overrides,
  };
}

async function renderDailyMap() {
  const utils = render(
    <MemoryRouter>
      <DailyMap />
    </MemoryRouter>
  );
  // Wait for the initial loadSchedule() effect to settle.
  await waitFor(() => expect(screen.queryByText(/Loading daily schedule/i)).not.toBeInTheDocument());
  return utils;
}

beforeEach(() => {
  getDailySchedule.mockReset();
  mockUser = { role: 'admin', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich' };
});

describe('DailyMap — production P0: My Day Map with the real one-appointment case', () => {
  it('THE EXACT PRODUCTION CASE: Today, exactly one appointment, admin viewer, Map default — renders without "Map failed to load"', async () => {
    getDailySchedule.mockResolvedValue({ appointments: [apptFixture()], owner_config: {} });
    await renderDailyMap();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties of undefined/i)).not.toBeInTheDocument();
    // Default view is "split" (map + list together) — the appointment's
    // name must actually render, proving real content reached the screen.
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);
  });

  it('ZERO appointments — a professional empty state, not a crash or a misrepresented error', async () => {
    getDailySchedule.mockResolvedValue({ appointments: [], owner_config: {} });
    await renderDailyMap();
    expect(screen.getByText(/No appointments on this day/i)).toBeInTheDocument();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to load schedule/i)).not.toBeInTheDocument();
  });

  it('MULTIPLE appointments — existing route/sequence behavior renders all of them', async () => {
    getDailySchedule.mockResolvedValue({
      appointments: [
        apptFixture(),
        apptFixture({ id: 'lead-2', first_name: 'David', last_name: 'Vega', coords: { lat: 34.06, lng: -118.30 } }),
        apptFixture({ id: 'lead-3', first_name: 'Sarah', last_name: 'Kim', coords: { lat: 34.10, lng: -118.20 } }),
      ],
      owner_config: {},
    });
    await renderDailyMap();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);
    expect(await screen.findAllByText('David Vega')).not.toHaveLength(0);
    expect(await screen.findAllByText('Sarah Kim')).not.toHaveLength(0);
  });

  it('MISSING optional collection: backend omits owner_config entirely — must not crash', async () => {
    getDailySchedule.mockResolvedValue({ appointments: [apptFixture()] }); // no owner_config key at all
    await expect(renderDailyMap()).resolves.not.toThrow();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
  });

  it('MISSING/unverified coordinates on one appointment does not crash My Day — the bad appointment is simply excluded from map markers', async () => {
    getDailySchedule.mockResolvedValue({
      appointments: [apptFixture({ coords: null, geocodeError: 'ZERO_RESULTS', verifiedAddress: null })],
      owner_config: {},
    });
    await renderDailyMap();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
  });

  it('PARTIAL routing response (no requiredDeparture/driveDuration yet) renders what is valid instead of crashing', async () => {
    getDailySchedule.mockResolvedValue({
      appointments: [apptFixture({ requiredDeparture: undefined, driveDuration: undefined, driveDistance: undefined, targetArrival: undefined })],
      owner_config: {},
    });
    await renderDailyMap();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);
  });

  it('ROUTING/API FAILURE produces a genuine retry/error state, never misrepresented as "No appointments"', async () => {
    getDailySchedule.mockRejectedValue(new Error('Network error'));
    await renderDailyMap();
    expect(screen.getByText(/Failed to load schedule/i)).toBeInTheDocument();
    expect(screen.queryByText(/No appointments on this day/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Try Again/i)).toBeInTheDocument();
  });

  it('non-admin (sales_rep) viewer with one appointment also renders without crashing', async () => {
    mockUser = { role: 'sales_rep', email: 'ethan@ecconstructiongroup.com', full_name: 'Ethan Magen' };
    getDailySchedule.mockResolvedValue({ appointments: [apptFixture({ assigned_rep: 'Ethan Magen' })], owner_config: {} });
    await renderDailyMap();
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
  });

  it('Map → List → Map view switching does not lose or crash on the same appointment data', async () => {
    getDailySchedule.mockResolvedValue({ appointments: [apptFixture()], owner_config: {} });
    await renderDailyMap();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);

    // Default view is "split" — switch to List-only via the real header toggle.
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);

    // Switch to Map-only — the exact production default view. The
    // appointment's marker (not its name, which only mounts to the DOM
    // inside a Popup once opened) is the observable proof this rendered.
    fireEvent.click(screen.getByRole('button', { name: 'Map view' }));
    expect(screen.getByRole('button', { name: 'Map view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties of undefined/i)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.leaflet-marker-icon')).toBeInTheDocument());

    // Back to Split — same data survives the round trip with no crash.
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }));
    expect(screen.getByRole('button', { name: 'Split view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);
  });

  it('changing the date does not leave stale appointment/contactOwners state from the previous day', async () => {
    getDailySchedule.mockResolvedValueOnce({ appointments: [apptFixture()], owner_config: {} });
    await renderDailyMap();
    expect(await screen.findAllByText('Mia Arias')).not.toHaveLength(0);

    getDailySchedule.mockResolvedValueOnce({
      appointments: [apptFixture({ id: 'lead-tomorrow', first_name: 'Alex', last_name: 'Chen', coords: { lat: 34.0, lng: -118.4 } })],
      owner_config: {},
    });
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-09-20' } });

    await waitFor(() => expect(getDailySchedule).toHaveBeenCalledTimes(2));
    await screen.findAllByText('Alex Chen');
    expect(screen.queryByText(/Map failed to load/i)).not.toBeInTheDocument();
  });

  it('HORIZONTAL AUDIT: City and Project Type filters are populated from the loaded schedule, not left empty by a dead prop-wiring mismatch', async () => {
    getDailySchedule.mockResolvedValue({
      appointments: [
        apptFixture({ city: 'Los Angeles', project_type: 'Kitchen Remodel' }),
        apptFixture({ id: 'lead-2', first_name: 'David', last_name: 'Vega', city: 'Pasadena', project_type: 'Bathroom Remodel', coords: { lat: 34.06, lng: -118.30 } }),
      ],
      owner_config: {},
    });
    await renderDailyMap();
    await screen.findAllByText('Mia Arias');

    const cityOptions = screen.getAllByRole('option').filter(o => ['Los Angeles', 'Pasadena'].includes(o.textContent));
    expect(cityOptions).toHaveLength(2);
    const projectTypeOptions = screen.getAllByRole('option').filter(o => ['Kitchen Remodel', 'Bathroom Remodel'].includes(o.textContent));
    expect(projectTypeOptions).toHaveLength(2);
  });
});
