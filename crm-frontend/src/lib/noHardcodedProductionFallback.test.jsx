/**
 * noHardcodedProductionFallback.test.jsx — PRODUCTIZATION DRIFT GUARD.
 *
 * Regression for a found-in-audit defect: apiConfig.js fell back to EC's
 * own live production Railway API URL
 * (https://qb-proxy-server-production.up.railway.app) whenever no
 * VITE_RAILWAY_API_URL-family env var was set at build time — a
 * misconfigured Company #4 frontend build would silently talk to EC's own
 * backend instead of failing visibly. Fixed to fall back to null instead
 * (see apiConfig.test.jsx).
 *
 * This guard repo-wide-scans crm-frontend/src for the same class of
 * mistake: a literal EC production URL/domain used as an unconditional `||`
 * fallback value, so a future edit (to apiConfig.js or anywhere else)
 * can't silently reintroduce it. Two already-reviewed, documented
 * fetch-failure fallbacks (see docs/CONFIGURATION_REFERENCE.md's "Deferred
 * work") are allowlisted by file path — this guard is about catching NEW,
 * undocumented instances, not re-litigating those two.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

// Already-reviewed, documented, low-severity fetch-failure fallbacks (not
// build-time-env-var fallbacks like apiConfig.js's fixed bug) — see
// docs/CONFIGURATION_REFERENCE.md's "Deferred work" section.
const ALLOWLISTED_FILES = new Set([
  'lib/crmEmailTemplates.js',
  'lib/emailTransport.js',
]);

const FORBIDDEN_FALLBACK_PATTERNS = [
  /\|\|\s*['"`]https?:\/\/[a-zA-Z0-9.-]*\.up\.railway\.app/,
  /\|\|\s*['"`]https?:\/\/[a-zA-Z0-9.-]*ecconstructiongroup\.com/,
];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist'].includes(ent.name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.jsx?$/.test(ent.name)) out.push(full);
  }
}

describe('no hardcoded production URL/domain fallback outside the documented allowlist', () => {
  it('scans every non-test crm-frontend/src file for an unconditional EC-production `||` fallback', () => {
    const files = [];
    walk(SRC_ROOT, files);
    const offenders = [];
    for (const full of files) {
      const rel = path.relative(SRC_ROOT, full).split(path.sep).join('/');
      if (ALLOWLISTED_FILES.has(rel)) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const pattern of FORBIDDEN_FALLBACK_PATTERNS) {
        if (pattern.test(src)) offenders.push(rel);
      }
    }
    expect(offenders, `Found a hardcoded EC-production fallback outside the documented allowlist: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the allowlist itself only names files that actually still contain the pattern (keeps the allowlist honest)', () => {
    for (const rel of ALLOWLISTED_FILES) {
      const full = path.join(SRC_ROOT, rel);
      const src = fs.readFileSync(full, 'utf8');
      const matches = FORBIDDEN_FALLBACK_PATTERNS.some((p) => p.test(src));
      expect(matches, `${rel} is allowlisted but no longer contains the pattern — remove it from ALLOWLISTED_FILES`).toBe(true);
    }
  });
});
