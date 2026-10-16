/**
 * MobileDayView.appleMapsDirections.test.jsx — My Day's List view "Navigate"
 * quick action must open the official Apple Maps directions link (not
 * Google Maps, and not the maps:// custom scheme, which fails on desktop
 * browsers and Android), using the appointment's own resolved address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileDayView from './MobileDayView';

vi.mock('@/pages/DailyMap', () => ({
  default: () => <div data-testid="daily-map-stub">stub</div>,
  fmt12: (t) => t,
  OWNER_COLORS: { Unassigned: { bg: '#000', text: 'white', label: 'Unassigned' } },
}));

const listLeads = vi.fn();
vi.mock('@/api/railway/leads', () => ({
  list: (...args) => listLeads(...args),
}));

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich' } }),
}));

function getTodayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function leadFixture(overrides = {}) {
  return {
    id: 'lead-1', first_name: 'Jamey', last_name: 'Corey', status: 'Active',
    assigned_rep: 'Yaron Drilevich',
    follow_up_type: 'Meeting', follow_up_date: getTodayLocal(), follow_up_time: '12:00', follow_up_status: 'pending',
    appointment_date: null, appointment_type: null, appointment_time: null,
    property_address: '1 Main St', city: 'Los Angeles',
    ...overrides,
  };
}

let openSpy;
beforeEach(() => {
  listLeads.mockReset();
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
});

async function renderMyDayList() {
  render(
    <MemoryRouter initialEntries={['/my-day']}>
      <MobileDayView />
    </MemoryRouter>
  );
  await screen.findByText('My Day');
  fireEvent.click(screen.getByText('List'));
}

describe('My Day List view — Navigate quick action', () => {
  it('opens the official Apple Maps directions link with the appointment address, not Google Maps', async () => {
    listLeads.mockResolvedValue({ items: [leadFixture()] });
    await renderMyDayList();
    const navigateBtn = await screen.findByText('Navigate');
    fireEvent.click(navigateBtn);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target] = openSpy.mock.calls[0];
    expect(url).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=/);
    expect(url).not.toContain('google.com');
    expect(url).toContain(encodeURIComponent('1 Main St'));
    expect(target).toBe('_blank');
  });

  it('never opens the maps:// custom scheme (fails on desktop/Android)', async () => {
    listLeads.mockResolvedValue({ items: [leadFixture()] });
    await renderMyDayList();
    fireEvent.click(await screen.findByText('Navigate'));
    const [url] = openSpy.mock.calls[0];
    expect(url.startsWith('maps://')).toBe(false);
  });

  it('a lead with a city but no real street address shows no Navigate action (never links to the bare "City, CA" fallback)', async () => {
    // The List view's own lead filter (l.property_address || l.city) still
    // lets this lead through — city alone used to be enough to build a
    // "<blank>, Los Angeles, CA" address that was always truthy and always
    // showed Navigate, pointing at a useless destination. It must not now.
    listLeads.mockResolvedValue({ items: [leadFixture({ property_address: null, city: 'Los Angeles' })] });
    await renderMyDayList();
    await screen.findByText(/Jamey/);
    expect(screen.queryByText('Navigate')).not.toBeInTheDocument();
  });
});
