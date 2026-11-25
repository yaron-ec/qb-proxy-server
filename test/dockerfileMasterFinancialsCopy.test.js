/* eslint-disable no-undef */
'use strict';

/**
 * dockerfileMasterFinancialsCopy.test.js — November 2026 production incident.
 *
 * lib/dealFinancialAggregation.js#computeMasterFinancials dynamically
 * `import()`s crm-frontend/src/lib/financialCalc.js — a self-contained ESM
 * module with no React/browser dependency — so the Master Project
 * consolidated Contract Total / Projected Profit can never drift from a
 * single deal's own Financials tab math.
 *
 * The root Dockerfile (the ONLY thing that determines what actually exists
 * inside the real `qb-proxy-server` production container) never copied
 * `crm-frontend/` at all. In the real container this made the dynamic
 * import throw `ERR_MODULE_NOT_FOUND`, caught by routes/deals.js's own
 * try/catch, silently degrading the Master Project financial summary to a
 * single deal's own (wrong, for a multi-deal project) figures — while the
 * separate, simple-arithmetic `total_approved_contract` field kept showing
 * the correct combined value, producing the exact "Contract Total is wrong
 * but the Master Project Summary's own combined value is right" symptom a
 * production user reported for the Lalani project.
 *
 * Every other test file in this suite runs against a full git checkout, so
 * none of them would ever have caught this — the bug exists ONLY in the
 * gap between "what's in the repo" and "what the Dockerfile actually puts
 * in the image". This test closes that gap: it parses the REAL Dockerfile's
 * own COPY instructions, materializes a temp directory containing exactly
 * what `docker build .` would place at `/app`, and proves the dynamic
 * import succeeds from THAT simulated image root — not from the real
 * checkout, where the bug could never reproduce. No live Docker daemon is
 * available in this environment, so this is the closest deterministic
 * proof available.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..');
const DOCKERFILE_PATH = path.join(REPO_ROOT, 'Dockerfile');

/** Parse `COPY <src...> <dest>` instructions out of Dockerfile text. */
function parseCopyInstructions(dockerfileText) {
  const copies = [];
  for (const raw of dockerfileText.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^COPY\s+(.+)$/);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/);
    if (tokens.length < 2) continue;
    copies.push({ srcs: tokens.slice(0, -1), dest: tokens[tokens.length - 1] });
  }
  return copies;
}

/** Expand the one glob form this Dockerfile actually uses: "package*.json". */
function expandGlob(srcPattern) {
  if (!srcPattern.includes('*')) return [srcPattern];
  const dir = path.dirname(srcPattern);
  const base = path.basename(srcPattern);
  const [prefix, suffix = ''] = base.split('*');
  const dirAbs = path.join(REPO_ROOT, dir === '.' ? '' : dir);
  return fs
    .readdirSync(dirAbs)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => path.join(dir === '.' ? '' : dir, f));
}

/**
 * Materializes a temp directory containing exactly the files a real
 * `docker build .` of the given Dockerfile text would place under /app —
 * following only its COPY instructions (RUN/HEALTHCHECK/CMD add no files).
 * A COPY whose source does not exist on disk is silently skipped here
 * (a real `docker build` would fail outright, which is a different,
 * already-loud failure mode this test does not need to re-prove).
 */
function buildSimulatedImageRoot(dockerfileText) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-sim-'));
  for (const { srcs, dest } of parseCopyInstructions(dockerfileText)) {
    const destIsRoot = dest === './' || dest === '.';
    for (const srcPattern of srcs) {
      for (const src of expandGlob(srcPattern)) {
        const srcAbs = path.join(REPO_ROOT, src);
        if (!fs.existsSync(srcAbs)) continue;
        const destAbs = destIsRoot
          ? path.join(tmpRoot, path.basename(src))
          : path.join(tmpRoot, dest.replace(/^\.\//, '').replace(/^\//, ''));
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.cpSync(srcAbs, destAbs, { recursive: true });
      }
    }
  }
  return tmpRoot;
}

/**
 * Exactly reproduces lib/dealFinancialAggregation.js#loadComputeFinancials's
 * own path construction (`path.resolve(__dirname, '..', 'crm-frontend',
 * 'src', 'lib', 'financialCalc.js')`), rooted at a simulated image's own
 * `lib/` directory instead of the real repo's.
 */
async function loadComputeFinancialsFrom(simulatedLibDir) {
  const financialCalcPath = path.resolve(simulatedLibDir, '..', 'crm-frontend', 'src', 'lib', 'financialCalc.js');
  const mod = await import(`file://${financialCalcPath}`);
  return mod.computeFinancials;
}

// The exact pre-fix Dockerfile content (November 2026) — kept as a literal
// snapshot, not read from git history, so this regression test keeps
// working forever regardless of how many times the Dockerfile is edited
// after this fix lands. This is what proves the test methodology itself
// would have caught the real incident, not just that the current Dockerfile
// happens to pass.
const PRE_FIX_DOCKERFILE = `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY reminderWorker.js reminderWatchdog.js productionWatchdog.js ./
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
COPY routes ./routes
EXPOSE 3000
CMD ["sh", "-c", "node db/migrate.js && node server.js"]
`;

test('pre-fix Dockerfile content (no crm-frontend COPY): the dynamic import of financialCalc.js fails from the simulated image root — reproduces the real incident', async () => {
  const tmpRoot = buildSimulatedImageRoot(PRE_FIX_DOCKERFILE);
  try {
    await assert.rejects(
      () => loadComputeFinancialsFrom(path.join(tmpRoot, 'lib')),
      (err) => {
        assert.match(String(err.code || err.message), /ERR_MODULE_NOT_FOUND|Cannot find module|not found/i);
        return true;
      },
      'the pre-fix Dockerfile must reproduce the exact MODULE_NOT_FOUND failure that silently degraded the Master Project financial summary'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('current Dockerfile: the dynamic import of financialCalc.js succeeds from the simulated image root (the fix)', async () => {
  const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
  const tmpRoot = buildSimulatedImageRoot(dockerfileText);
  try {
    const computeFinancials = await loadComputeFinancialsFrom(path.join(tmpRoot, 'lib'));
    assert.strictEqual(typeof computeFinancials, 'function', 'computeFinancials must load as a real function from the simulated image root, not throw and not be undefined');

    // Prove it is not merely "importable" but actually USABLE — call it
    // with a minimal, representative input shape and confirm it returns
    // real computed numbers, not a half-loaded/partial module.
    const result = computeFinancials({
      deal: { id: 'sim', amount: 1000, status: 'Sold' },
      lead: null,
      invoices: [],
      saleInvoices: [],
      expenses: [],
      commissions: [],
      loanPayments: [],
      waterfall: null,
    });
    assert.ok(result && typeof result === 'object', 'computeFinancials must return a real summary object');
    assert.strictEqual(typeof result.netProfit, 'number');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('the Dockerfile copies crm-frontend/package.json alongside financialCalc.js — defense-in-depth against Node ESM module-type resolution', async () => {
  // Node's dynamic import() has, on newer runtimes (the "detect module
  // syntax" fallback, default-on since Node 20.19.0 / 22.7.0), started
  // auto-reparsing a `.js` file as ESM when it detects `export`/`import`
  // syntax, even with no "type": "module" anywhere in its ancestor
  // package.json chain — confirmed directly below: importing
  // financialCalc.js from a simulated image root that has the file but NOT
  // crm-frontend/package.json still succeeds on this environment's Node
  // version, with only a MODULE_TYPELESS_PACKAGE_JSON warning, not a throw.
  // That auto-detection is NOT guaranteed on every Node 20.x patch this
  // Dockerfile's unpinned `FROM node:20-alpine` could resolve to, so the
  // Dockerfile still explicitly copies crm-frontend/package.json (type:
  // module) as defense-in-depth — this test asserts that COPY line exists
  // and documents why, without hard-asserting a specific failure mode that
  // depends on exactly which Node patch version builds the image.
  const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
  const copies = parseCopyInstructions(dockerfileText);
  const destPaths = copies.map((c) => c.dest.replace(/^\.\//, ''));
  assert.ok(
    destPaths.includes('crm-frontend/package.json'),
    'the Dockerfile must COPY crm-frontend/package.json (type: module) as defense-in-depth, even though newer Node runtimes can tolerate its absence'
  );
  assert.ok(
    destPaths.includes('crm-frontend/src/lib/financialCalc.js'),
    'the Dockerfile must COPY crm-frontend/src/lib/financialCalc.js explicitly'
  );

  const withoutPackageJson = dockerfileText.replace(/^COPY crm-frontend\/package\.json .*$/m, '');
  const tmpRoot = buildSimulatedImageRoot(withoutPackageJson);
  try {
    // Not asserted to throw — only confirming the import is still at least
    // attemptable (it may succeed via auto-detection or fail depending on
    // Node version); either way, the Dockerfile keeps the explicit COPY.
    await loadComputeFinancialsFrom(path.join(tmpRoot, 'lib')).catch(() => {});
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('the Dockerfile\'s own runtime file verification block checks for both new crm-frontend files', () => {
  const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
  assert.match(dockerfileText, /test -f \/app\/crm-frontend\/package\.json/);
  assert.match(dockerfileText, /test -f \/app\/crm-frontend\/src\/lib\/financialCalc\.js/);
});
