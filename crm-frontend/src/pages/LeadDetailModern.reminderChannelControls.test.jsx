/**
 * LeadDetailModern.reminderChannelControls.test.jsx — CRM repair item 10
 * (November 2026): source-level audit of the three Customer Reminders
 * controls in Lead Detail's sidebar (Master/Email/SMS — previously one
 * ambiguous toggle, "Reminder emails enabled", that never actually
 * affected SMS at all). Source-level, matching this file's existing
 * `invalidIdFix.test.jsx` convention for a page this large — a full mount
 * requires extensive unrelated context (auth, routing, every panel this
 * page renders) for a change that is really three Switch wirings.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'LeadDetailModern.jsx'), 'utf8');

describe('LeadDetailModern — Customer Reminders Master/Email/SMS controls', () => {
  it('renders a Master switch wired to customer_reminders_disabled', () => {
    expect(src).toContain('checked={!lead.customer_reminders_disabled}');
    expect(src).toContain('onCheckedChange={(checked) => updateField("customer_reminders_disabled", !checked)}');
  });

  it('renders an independent Email switch, disabled when Master is off, wired to customer_email_reminders_disabled', () => {
    expect(src).toContain('checked={!lead.customer_reminders_disabled && !lead.customer_email_reminders_disabled}');
    expect(src).toContain('onCheckedChange={(checked) => updateField("customer_email_reminders_disabled", !checked)}');
  });

  it('renders an independent SMS switch, disabled when Master is off, wired to customer_sms_reminders_disabled', () => {
    expect(src).toContain('checked={!lead.customer_reminders_disabled && !lead.customer_sms_reminders_disabled}');
    expect(src).toContain('onCheckedChange={(checked) => updateField("customer_sms_reminders_disabled", !checked)}');
  });

  it('the Email and SMS sub-switches are both disabled (greyed, non-interactive) whenever Master is off', () => {
    const matches = src.match(/disabled={!!lead\.customer_reminders_disabled}/g) || [];
    expect(matches.length).toBe(2); // exactly the Email and SMS sub-switches
  });

  it('the old ambiguous single-toggle label text is gone — SMS is no longer silently unmentioned', () => {
    expect(src).not.toContain('Reminder emails enabled');
    expect(src).toContain('Customer Reminders — Master');
    expect(src).toContain('Email Reminders');
    expect(src).toContain('SMS Reminders');
  });
});
