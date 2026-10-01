/**
 * MobileDayView.currentActionParity.test.jsx — DRIFT PROTECTION.
 *
 * Runs the shared canonical truth table (test/fixtures/currentActionCases.js)
 * against the exact predicate MobileDayView.jsx uses to decide whether a
 * lead has a current PHYSICAL meeting on a given day
 * (isCurrentPhysicalMeetingForDay, exported alongside the page's default
 * export purely for this test). The identical fixture is also run against
 * the backend's canonical lib/booking/currentAction.js
 * (test/currentAction.test.js) — if this file's logic is ever changed
 * inconsistently with a case below, THIS test fails immediately, without
 * needing a full component render or a backend run.
 *
 * FINAL RULE: current work is derived entirely from the Follow-Up — there
 * is no Appointment fallback. isCurrentPhysicalMeetingForDay(lead, day) is
 * only ever asked "does this lead's own Follow-Up make day `day` a
 * physical meeting" — each case's fixture `day` is always the Follow-Up's
 * own date when expected.isCurrent is true, so this maps directly.
 */
import { describe, it, expect } from 'vitest';
import { isCurrentPhysicalMeetingForDay } from './MobileDayView';
import CASES from '../../../test/fixtures/currentActionCases.js';

describe('MobileDayView.isCurrentPhysicalMeetingForDay — canonical fixture parity', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isCurrentPhysicalMeetingForDay(c.lead, c.day)).toBe(c.expected.isPhysicalMeeting);
    });
  }
});
