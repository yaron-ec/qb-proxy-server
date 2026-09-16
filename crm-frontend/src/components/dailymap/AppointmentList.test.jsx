/**
 * AppointmentList.test.jsx — the List-view sibling of the same production
 * crash class covered in MapView.test.jsx. pages/DailyMap.jsx's call site
 * for AppointmentList also omitted contactOwners (it passed an unrelated
 * `ownerConfig` object instead, which AppointmentList never even reads),
 * so expanding any appointment as an admin (which renders the "Reassign"
 * <select> and its {contactOwners.map(...)}) would have thrown the exact
 * same "Cannot read properties of undefined (reading 'map')" error. Fixed
 * the same way: the real call site now passes contactOwners, and the
 * component defaults it to [] for defense in depth.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppointmentList from './AppointmentList';

const oneAppt = {
  id: 'lead-mia', first_name: 'Mia', last_name: 'Arias',
  coords: { lat: 34.05, lng: -118.24 }, fullAddress: '123 Main St, Los Angeles, CA',
  follow_up_time: '14:00', assigned_rep: 'Yaron Drilevich', project_type: 'Kitchen Remodel',
  phone: '+18184008787', colorConfig: { bg: '#3B82F6' },
};

function renderList(props) {
  return render(
    <MemoryRouter>
      <AppointmentList
        appointments={[oneAppt]}
        selectedLead={null}
        onSelectLead={() => {}}
        userRole="admin"
        {...props}
      />
    </MemoryRouter>
  );
}

describe('AppointmentList — the undefined .map() crash on the expanded admin reassign dropdown', () => {
  it('renders the expanded admin reassign UI for the selected appointment without contactOwners passed, with no crash', () => {
    expect(() => {
      renderList({ selectedLead: 'lead-mia' }); // expanded, admin — hits {contactOwners.map(...)}
    }).not.toThrow();
  });

  it('renders normally (not expanded) with no contactOwners passed', () => {
    expect(() => {
      renderList({ selectedLead: null });
    }).not.toThrow();
  });

  it('renders zero appointments as an empty, header-only list (not a crash, not a fabricated error)', () => {
    render(
      <MemoryRouter>
        <AppointmentList appointments={[]} selectedLead={null} onSelectLead={() => {}} userRole="admin" />
      </MemoryRouter>
    );
    expect(screen.getByText(/0 Appointments/i)).toBeInTheDocument();
  });

  it('renders correctly with contactOwners actually supplied (post-fix DailyMap.jsx call site)', () => {
    renderList({ selectedLead: 'lead-mia', contactOwners: ['Yaron Drilevich', 'Ethan Magen'], onReassign: vi.fn() });
    expect(screen.getByText('Mia Arias')).toBeInTheDocument();
  });

  it('an appointment flagged with a geocode error shows "Address needs review" instead of silently hiding the problem', () => {
    render(
      <MemoryRouter>
        <AppointmentList
          appointments={[{ ...oneAppt, geocodeError: 'ZERO_RESULTS' }]}
          selectedLead={null}
          onSelectLead={() => {}}
          userRole="admin"
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/Address needs review/i)).toBeInTheDocument();
  });

  it('a schedule conflict is surfaced, not silently dropped', () => {
    render(
      <MemoryRouter>
        <AppointmentList
          appointments={[{ ...oneAppt, requiredDeparture: '13:15', conflict: { requiredDeparture: '1:15 PM', prevEndsAt: '1:30 PM' } }]}
          selectedLead={null}
          onSelectLead={() => {}}
          userRole="admin"
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/Schedule conflict/i)).toBeInTheDocument();
  });
});
