/**
 * LeadDetailModern.smsIntegration.test.jsx — source-level horizontal audit
 * for "CRM Lead Detail: Integrate SMS into the Main Activity and
 * Communication System" (October 2026), mirroring the existing
 * LeadDetailModern.invalidIdFix.test.jsx convention: this file is too large
 * to usefully full-mount for every wiring check, so these assert against
 * the actual shipped source for behavior that's otherwise only verifiable
 * by eye.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_PATH = path.join(__dirname, 'LeadDetailModern.jsx');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('SMS merged into the central chronological activity timeline', () => {
  it('fetches the real SMS conversation (routes/sms.js) and merges it into `activities` via the shared adapter — never a mirror write', () => {
    expect(src).toMatch(/railwaySms\.getConversation\(lead\.id\)/);
    expect(src).toMatch(/\.map\(smsMessageToActivity\)/);
    expect(src).toMatch(/import \{ smsMessageToActivity \} from "@\/lib\/smsActivityAdapter";/);
  });

  it('merges by id into a Map (the SAME dedup/update pattern the Gmail merge already uses), not a naive concat', () => {
    const smsEffect = src.match(/\/\/ SMS conversation[\s\S]*?\n  \}, \[lead\?\.id\]\);/)[0];
    expect(smsEffect).toMatch(/const byId = new Map\(prev\.map\(a => \[a\.id, a\]\)\);/);
  });

  it('polls (not a one-time fetch) so an inbound reply or a delivery-status change appears without a manual refresh', () => {
    const smsEffect = src.match(/\/\/ SMS conversation[\s\S]*?\n  \}, \[lead\?\.id\]\);/)[0];
    expect(smsEffect).toMatch(/setInterval\(load, 15000\)/);
    expect(smsEffect).toMatch(/clearInterval\(t\)/);
  });
});

describe('SMS filter tab, consistent with the existing activity filters', () => {
  it('the central activity filter tabs include "Text Messages"', () => {
    expect(src).toMatch(/\{ id: "sms", label: "Text Messages" \}/);
  });
});

describe('the redundant left-sidebar SMS composer was removed', () => {
  it('SmsPanel is no longer imported or rendered anywhere in Lead Detail', () => {
    expect(src).not.toMatch(/SmsPanel/);
  });

  it('the unrelated AppointmentReminderPanel sidebar control was preserved', () => {
    expect(src).toMatch(/<AppointmentReminderPanel lead=\{lead\} \/>/);
  });
});

describe('ActivityComposer is wired for the new Text Message tab\'s consent control', () => {
  it('both ActivityComposer call sites (desktop + mobile) pass onLeadUpdate={setLeadSafe}', () => {
    const matches = src.match(/<ActivityComposer lead=\{lead\}[^/]*\/>/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) expect(m).toMatch(/onLeadUpdate=\{setLeadSafe\}/);
  });
});

describe('ActivityCard never allows editing/deleting a synthetic SMS entry', () => {
  it('canEdit explicitly excludes type "sms"', () => {
    expect(src).toMatch(/const canEdit = activity\.type !== "sms" && !isSystemEntry && currentUser && \(/);
  });
});
