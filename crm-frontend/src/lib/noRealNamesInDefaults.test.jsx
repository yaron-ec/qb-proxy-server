/**
 * noRealNamesInDefaults.test.jsx — PRODUCTIZATION DRIFT GUARD.
 *
 * Regression for a found-in-audit defect: Settings.jsx, LeadCapture.jsx and
 * LeadDetailModern.jsx each hardcoded real EC individuals ("Sharon", "Yair",
 * "Ethan") as canonical default lead-source options, and Settings.jsx also
 * hardcoded a specific EC staff roster ("Ethan Magen", "Micky Gad", "Yaron
 * Drilevich") as the default Contact Owners list. A fresh installation of
 * this product would have silently inherited these real people's names as
 * "universal" product defaults before ever saving its own settings —
 * exactly the class of EC-identity leak the productization effort exists
 * to eliminate from shared runtime code.
 *
 * This guard scans the actual DEFAULT_SOURCES/DEFAULT_LEAD_SOURCES/
 * DEFAULT_CONTACT_OWNERS source text in these three files for any of EC's
 * known real individuals' first names, so a future edit can't silently
 * reintroduce one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.join(__dirname, '..', 'pages');

// Real EC individuals that have appeared in this codebase's hardcoded
// "universal" default lists. Generic categories like "Website" or
// "Referral" are never flagged — only named individuals.
const EC_NAMES = ['Sharon', 'Yair', 'Ethan', 'Micky', 'Karen', 'Matt'];

function extractConstBlock(src, constName) {
  const m = src.match(new RegExp(`const ${constName}\\s*=\\s*\\[[\\s\\S]*?\\];`));
  return m ? m[0] : null;
}

describe('DEFAULT_SOURCES / DEFAULT_LEAD_SOURCES / DEFAULT_CONTACT_OWNERS never hardcode a real EC individual', () => {
  const cases = [
    { file: 'Settings.jsx', consts: ['DEFAULT_SOURCES', 'DEFAULT_CONTACT_OWNERS'] },
    { file: 'LeadCapture.jsx', consts: ['DEFAULT_SOURCES'] },
    { file: 'LeadDetailModern.jsx', consts: ['DEFAULT_LEAD_SOURCES'] },
  ];

  for (const { file, consts } of cases) {
    for (const constName of consts) {
      it(`${file}'s ${constName} contains no real EC individual's name`, () => {
        const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
        const block = extractConstBlock(src, constName);
        expect(block, `${constName} not found in ${file}`).toBeTruthy();
        for (const name of EC_NAMES) {
          expect(block.includes(`"${name}"`)).toBe(false);
        }
      });
    }
  }
});
