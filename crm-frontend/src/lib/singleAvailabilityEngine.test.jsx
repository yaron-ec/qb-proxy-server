import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * singleAvailabilityEngine.test.jsx — horizontal-audit regression guard.
 *
 * Production defect: New Lead correctly used the canonical backend
 * availability engine, but the Lead Detail Appointment editor, Activity
 * Composer and Call Log all used a SEPARATE, stale client-side calculation
 * (lib/calendarAvailability.js) that scanned raw lead rows with a flat,
 * wrong buffer rule and never read the real Google Calendar — able to show
 * a slot as available when the canonical engine (and the backend write
 * path) would not. Fixed by deleting that duplicate engine and routing every
 * consumer through api/railway/availability.js (GET /api/v1/availability).
 *
 * This test fails if:
 *   (a) the deleted duplicate engine file is ever recreated, or
 *   (b) any component re-imports from it instead of the canonical client.
 */
const SRC_DIR = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('single canonical availability engine', () => {
  it('the deleted duplicate client-side engine (lib/calendarAvailability.js) does not exist', () => {
    const stalePath = path.join(SRC_DIR, 'lib', 'calendarAvailability.js');
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('no source file imports from the deleted @/lib/calendarAvailability module', () => {
    const importPattern = /from\s+['"]@\/lib\/calendarAvailability['"]|require\(['"]@\/lib\/calendarAvailability['"]\)/;
    const offenders = [];
    for (const file of walk(SRC_DIR)) {
      if (file === __filename) continue; // this guard's own file may reference the name in prose
      const content = fs.readFileSync(file, 'utf8');
      if (importPattern.test(content)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it('AvailableTimePicker, AppointmentSlotPicker and AppointmentEditor all use the canonical api/railway/availability client', () => {
    for (const rel of ['components/AvailableTimePicker.jsx', 'components/AppointmentSlotPicker.jsx', 'components/AppointmentEditor.jsx']) {
      const content = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
      expect(content.includes('@/api/railway/availability')).toBe(true);
    }
  });
});
