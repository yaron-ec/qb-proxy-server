/**
 * FollowUpsWidget.currentActionParity.test.jsx — DRIFT PROTECTION.
 *
 * Runs the shared canonical truth table (test/fixtures/currentActionCases.js)
 * against the exact predicate FollowUpsWidget.jsx uses to decide whether a
 * lead's Appointment is superseded by an active Meeting Follow-Up
 * (isAppointmentSupersededByFollowUp, exported alongside the component's
 * default export purely for this test). The identical fixture is also run
 * against the backend's canonical lib/booking/currentAction.js
 * (test/currentAction.test.js) and against
 * crm-frontend/src/pages/MobileDayView.jsx
 * (MobileDayView.currentActionParity.test.jsx) — if this file's logic is
 * ever changed inconsistently with a case below, THIS test fails
 * immediately, without needing a full component render or a backend run.
 *
 * Every fixture case's `day` is the Appointment's own date, so this
 * single-argument predicate (no separate `day` parameter — it always
 * evaluates the Appointment on its own date) is exercised correctly
 * against the same cases the two-argument backend/MobileDayView
 * predicates use.
 */
import { describe, it, expect } from 'vitest';
import { isAppointmentSupersededByFollowUp } from './FollowUpsWidget';
import CASES from '../../../test/fixtures/currentActionCases.js';

describe('FollowUpsWidget.isAppointmentSupersededByFollowUp — canonical fixture parity', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isAppointmentSupersededByFollowUp(c.lead)).toBe(c.superseded);
    });
  }
});
