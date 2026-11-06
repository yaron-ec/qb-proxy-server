'use strict';
/**
 * Pure, unit-testable "would this push have redeployed service X on
 * Railway?" matcher — used by .github/workflows/ci.yml's verify-production
 * job so it reports SKIPPED (not FAILED) for a service whose Watch Paths
 * weren't touched by this push, instead of polling for a version that was
 * never going to appear.
 *
 * SERVICE_WATCH_PATTERNS mirrors the ACTUAL Railway Watch Paths configured
 * for each service in the devoted-courtesy project, confirmed directly via
 * the Railway API during the November 2026 production-version-verification
 * audit (see CLAUDE.md's "PR #59 frontend silent-non-deploy incident"
 * section) — NOT the stale, inert root railway.json. There is deliberately
 * no live Railway credential wired into CI to read this automatically (see
 * the "no new privileged CI credentials" constraint) — whoever changes a
 * service's Watch Paths in the Railway dashboard must update this file to
 * match, or this check will silently drift out of sync with reality again,
 * the exact class of bug this file exists to fix.
 */

const SERVICE_WATCH_PATTERNS = {
  'qb-proxy-server': [
    'package.json',
    'package-lock.json',
    'server.js',
    'reminderWorker.js',
    'reminderWatchdog.js',
    'productionWatchdog.js',
    'lib/**',
    'db/**',
    'scripts/**',
    'routes/**',
    'Dockerfile',
    '.dockerignore',
  ],
  'insightful-encouragement': [
    'crm-frontend/**',
    'Dockerfile.frontend',
    '.dockerignore',
    'src/**',
  ],
};

/** Strip any number of leading slashes so '/lib/**' and 'lib/**' match identically. */
function normalize(p) {
  return String(p).replace(/^\/+/, '');
}

/**
 * A 'prefix/**' pattern matches the prefix itself and anything under it.
 * Every other pattern (a bare filename like 'server.js' or 'Dockerfile')
 * must match exactly — this mirrors Railway's own Watch Paths semantics for
 * the simple glob shapes actually used by any service in this project.
 */
function matchesPattern(filePath, pattern) {
  const file = normalize(filePath);
  const pat = normalize(pattern);
  if (pat === '**') return true;
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return file === prefix || file.startsWith(prefix + '/');
  }
  return file === pat;
}

/** True if ANY changed file matches ANY of the given patterns. */
function isRelevant(changedFiles, patterns) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return changedFiles.some((f) => patterns.some((p) => matchesPattern(f, p)));
}

function isServiceRelevant(serviceKey, changedFiles) {
  const patterns = SERVICE_WATCH_PATTERNS[serviceKey];
  if (!patterns) throw new Error(`Unknown service key: ${serviceKey}`);
  return isRelevant(changedFiles, patterns);
}

module.exports = { SERVICE_WATCH_PATTERNS, matchesPattern, isRelevant, isServiceRelevant };

// CLI: node scripts/ci/computeDeployRelevance.js <service-key> <file1> <file2> ...
// Prints exactly 'true' or 'false' to stdout, exits 0. Exits 1 with a
// stderr message for an unknown service key — the workflow step treats
// that as "cannot determine, default to running the check" (fail-safe).
if (require.main === module) {
  const [serviceKey, ...files] = process.argv.slice(2);
  try {
    process.stdout.write(isServiceRelevant(serviceKey, files) ? 'true' : 'false');
    process.exit(0);
  } catch (e) {
    process.stderr.write(String(e.message || e) + '\n');
    process.exit(1);
  }
}
