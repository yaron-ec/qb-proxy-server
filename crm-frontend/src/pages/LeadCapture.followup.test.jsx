import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * LeadCapture.followup.test.jsx — the redundant manual "Follow-up (Optional)"
 * section is gone. appointment_date/appointment_time are mandatory on this
 * form (validate() requires both), and the backend
 * (routes/publicCapture.js -> bookingService.createBooking) always derives
 * follow_up_date/time/type and meeting_stage from the appointment itself —
 * so a second, manually-entered Follow-up Date/Time/Type was always
 * silently discarded. A source-level check (rather than a full render test,
 * given this form's size and router/context dependencies) that the dead
 * fields and the FormCard that exposed them are actually removed, not just
 * hidden.
 */
const src = fs.readFileSync(path.join(process.cwd(), 'src/pages/LeadCapture.jsx'), 'utf8');

describe('LeadCapture — no redundant manual follow-up entry', () => {
  it('does not render a "Follow-up (Optional)" section', () => {
    expect(src).not.toMatch(/Follow-up \(Optional\)/);
  });

  it('does not track follow_up_date/time/type as separate form state', () => {
    expect(src).not.toMatch(/follow_up_date:\s*"/);
    expect(src).not.toMatch(/follow_up_time:\s*"/);
    expect(src).not.toMatch(/follow_up_type:\s*"/);
  });

  it('still requires appointment_date/appointment_time (the single source of truth for follow-up)', () => {
    expect(src).toMatch(/appointment_date.*Required/);
    expect(src).toMatch(/appointment_time.*Required/);
  });
});
