/**
 * FollowUpsWidget.currentActionParity.test.jsx — DRIFT PROTECTION.
 *
 * Runs the shared canonical truth table (test/fixtures/currentActionCases.js)
 * against the exact predicate FollowUpsWidget.jsx uses to decide whether a
 * lead has current work for a given day (isFollowUpCurrentForDay, exported
 * alongside the component's default export purely for this test). The
 * identical fixture is also run against the backend's canonical
 * lib/booking/currentAction.js (test/currentAction.test.js) and against
 * crm-frontend/src/pages/MobileDayView.jsx
 * (MobileDayView.currentActionParity.test.jsx) — if this file's logic is
 * ever changed inconsistently with a case below, THIS test fails
 * immediately, without needing a full component render or a backend run.
 *
 * FINAL RULE: current work is derived entirely from the Follow-Up — there is
 * no Appointment fallback. isFollowUpCurrentForDay never reads
 * appointment_date/appointment_type at all, so every case's expected
 * `isCurrent` maps directly regardless of what the Appointment fields say.
 */
import { describe, it, expect } from 'vitest';
import { isFollowUpCurrentForDay } from './FollowUpsWidget';
import CASES from '../../../test/fixtures/currentActionCases.js';

describe('FollowUpsWidget.isFollowUpCurrentForDay — canonical fixture parity', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isFollowUpCurrentForDay(c.lead, c.day)).toBe(c.expected.isCurrent);
    });
  }
});
