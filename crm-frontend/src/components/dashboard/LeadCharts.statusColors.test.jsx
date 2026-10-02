/**
 * LeadCharts.statusColors.test.jsx — regression coverage: LeadCharts.jsx's
 * "Leads by Status" chart STATUS_COLORS map previously used invented/stale
 * status names that never match a real lead.status value (found in the
 * system-wide stability audit), so most real statuses rendered as the same
 * gray fallback color instead of a distinct one. Fixed to match the app's
 * real status vocabulary (pages/LeadDetailModern.jsx's STATUSES).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'LeadCharts.jsx'), 'utf8');
const REAL_STATUSES = [
  "New", "Appointment scheduled", "Answered, no appointment set", "No answer",
  "Proposal Sent", "No show", "DNQ", "Sold", "Lost",
];

describe('LeadCharts.jsx STATUS_COLORS matches the app\'s real status vocabulary', () => {
  it('has a color entry for every real status', () => {
    const colorsBlock = src.match(/const STATUS_COLORS = \{([\s\S]*?)\};/)[1];
    for (const status of REAL_STATUSES) {
      expect(colorsBlock).toContain(`"${status}"`);
    }
  });

  it('REGRESSION: no longer contains the old invented statuses that never matched real data', () => {
    const colorsBlock = src.match(/const STATUS_COLORS = \{([\s\S]*?)\};/)[1];
    for (const stale of ["Contacted", "Qualified", "Estimate Sent", "Close won", "Closed Lost", "Unqualified"]) {
      expect(colorsBlock).not.toContain(`"${stale}"`);
    }
  });
});
