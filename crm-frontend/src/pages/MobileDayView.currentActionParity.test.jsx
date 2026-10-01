/**
 * MobileDayView.currentActionParity.test.jsx — DRIFT PROTECTION.
 *
 * Runs the shared canonical truth table (test/fixtures/currentActionCases.js)
 * against the exact predicate MobileDayView.jsx uses to decide whether a
 * lead's Appointment is superseded by an active Meeting Follow-Up
 * (isAppointmentSupersededForDay, exported alongside the page's default
 * export purely for this test). The identical fixture is also run against
 * the backend's canonical lib/booking/currentAction.js
 * (test/currentAction.test.js) and against
 * crm-frontend/src/components/FollowUpsWidget.jsx
 * (FollowUpsWidget.currentActionParity.test.jsx) — if this file's logic is
 * ever changed inconsistently with a case below, THIS test fails
 * immediately, without needing a full component render or a backend run.
 */
import { describe, it, expect } from 'vitest';
import { isAppointmentSupersededForDay } from './MobileDayView';
import CASES from '../../../test/fixtures/currentActionCases.js';

describe('MobileDayView.isAppointmentSupersededForDay — canonical fixture parity', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isAppointmentSupersededForDay(c.lead, c.day)).toBe(c.superseded);
    });
  }
});
