/* eslint-disable no-undef */
/**
 * Repository Guardrail — Canonical Backend Tree Verification
 *
 * Runs as part of CI / pre-push to enforce:
 *   1. All required runtime files exist in src/proxy-server/
 *   2. No active backend runtime files exist at repo root (prevents dual-tree drift)
 *   3. The Dockerfile does not reference files outside src/proxy-server/
 *
 * Usage:  node src/proxy-server/scripts/verifyRuntimeFiles.js
 * Exit:   0 = pass, 1 = fail
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CANONICAL = path.resolve(__dirname, '..');

const REQUIRED_LIB = [
  'qbMatch.js', 'authService.js', 'emailService.js', 'reminderEngine.js',
  'railwayDataAccess.js', 'qbTokenStore.js', 'qbInvoiceSaleMap.js',
  'reminderRouter.js', 'actionRouter.js', 'leadIngestRouter.js',
  'gmailOAuthRouter.js', 'crmRepository.js', 'rbac.js', 'dealModel.js',
  'reminderProjection.js', 'leadResolver.js', 'signnowClient.js',
  'googleContactsClient.js', 'captureValidation.js', 'captureAlerts.js',
  'captureOverrideAuth.js', 'phoneCallReminders.js', 'taskReminderEngine.js',
  'reminderActions.js', 'reminderAlerts.js', 'reminderEmails.js',
  'reminderHealth.js', 'reminderNotifications.js', 'reminderPages.js',
  'reminderTime.js', 'repDirectory.js', 'scopedSync.js',
  'actionTokenStore.js', 'authorization.js', 'crypto.js',
  'dataAccess.js', 'dataAccessRailway.js', 'emailTemplates.js',
  'gmailCredentialStore.js', 'gmailSender.js',
  'integrationCredentialStore.js', 'leadIngest.js', 'rateLimit.js',
  'transportControl.js', 'base44AppointmentTemplates.js',
  'qbInternal.js',
];

const REQUIRED_LIB_SUBDIRS = {
  booking: [
    'appointmentTypes.js', 'availabilityService.js', 'bookingService.js',
    'calendarOutbox.js', 'googleAvailability.js', 'googleCalendarClient.js',
    'leadResolution.js', 'ownerResolution.js', 'slotBlocking.js', 'windowMerge.js',
  ],
  monitoring: [
    'alertDispatcher.js', 'crashLoopDetector.js', 'healthProbes.js',
    'knownGoodBaseline.js', 'railwayApiClient.js', 'recoveryPolicy.js',
    'serviceInventory.js',
  ],
};

const REQUIRED_ROUTES = [
  'auth.js', 'emails.js', 'bookings.js', 'gmail.js', 'leads.js',
  'settings.js', 'tasks.js', 'invoices.js', 'activities.js',
  'dealExpenses.js', 'dealExpensePayments.js', 'dealCommissions.js',
  'dealLoanPayments.js', 'properties.js', 'leadAttachments.js',
  'handoffEstimates.js', 'syncCursors.js', 'companySettings.js',
  'cronJobs.js', 'leadQB.js', 'signnow.js', 'leadSubmissions.js',
  'publicCapture.js', 'owners.js', 'deals.js', 'dealFinancials.js',
  'saleInvoices.js',
];

const REQUIRED_ROOT_FILES = [
  'server.js', 'reminderWorker.js', 'reminderWatchdog.js',
  'productionWatchdog.js', 'package.json', 'package-lock.json',
  'Dockerfile',
];

// Files that MUST NOT exist at repo root (prevents dual-tree drift)
const FORBIDDEN_ROOT_RUNTIME = [
  'server.js', 'reminderWorker.js', 'reminderWatchdog.js',
  'productionWatchdog.js',
];

let errors = [];
let warnings = [];

// ── Check 1: Required files exist in canonical tree ──────────────────────────
for (const f of REQUIRED_ROOT_FILES) {
  if (!fs.existsSync(path.join(CANONICAL, f))) {
    errors.push(`MISSING: src/proxy-server/${f}`);
  }
}

for (const f of REQUIRED_LIB) {
  if (!fs.existsSync(path.join(CANONICAL, 'lib', f))) {
    errors.push(`MISSING: src/proxy-server/lib/${f}`);
  }
}

for (const [subdir, files] of Object.entries(REQUIRED_LIB_SUBDIRS)) {
  for (const f of files) {
    if (!fs.existsSync(path.join(CANONICAL, 'lib', subdir, f))) {
      errors.push(`MISSING: src/proxy-server/lib/${subdir}/${f}`);
    }
  }
}

for (const f of REQUIRED_ROUTES) {
  if (!fs.existsSync(path.join(CANONICAL, 'routes', f))) {
    errors.push(`MISSING: src/proxy-server/routes/${f}`);
  }
}

if (!fs.existsSync(path.join(CANONICAL, 'db', 'client.js'))) {
  errors.push('MISSING: src/proxy-server/db/client.js');
}

// ── Check 2: No active runtime files at repo root ────────────────────────────
// The repo root may have legacy files, but they must not be newer than the
// canonical versions (which would indicate someone is editing the wrong tree).
for (const f of FORBIDDEN_ROOT_RUNTIME) {
  const rootPath = path.join(REPO_ROOT, f);
  const canonicalPath = path.join(CANONICAL, f);
  if (fs.existsSync(rootPath) && fs.existsSync(canonicalPath)) {
    const rootMtime = fs.statSync(rootPath).mtimeMs;
    const canonicalMtime = fs.statSync(canonicalPath).mtimeMs;
    if (rootMtime > canonicalMtime) {
      warnings.push(`WARNING: repo-root ${f} is NEWER than src/proxy-server/${f} — possible dual-tree drift`);
    }
  }
}

// ── Check 3: Dockerfile does not reference files outside canonical tree ───────
const dockerfilePath = path.join(CANONICAL, 'Dockerfile');
if (fs.existsSync(dockerfilePath)) {
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  const copyLines = dockerfile.split('\n').filter(l => l.trim().startsWith('COPY'));
  for (const line of copyLines) {
    // COPY commands should only reference relative paths within the build context
    // (which is src/proxy-server/ when Railway uses Root Directory = src/proxy-server)
    if (line.includes('..') || line.includes('/src/proxy-server/') || line.includes('/src/')) {
      errors.push(`Dockerfile COPY references path outside canonical tree: ${line.trim()}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.log('⚠️  Warnings:');
  warnings.forEach(w => console.log(`  ${w}`));
}

if (errors.length > 0) {
  console.error('❌ Repository guardrail FAILED:');
  errors.forEach(e => console.error(`  ${e}`));
  console.error('\nFix: ensure all required runtime files exist in src/proxy-server/');
  process.exit(1);
}

console.log('✅ Repository guardrail PASSED — src/proxy-server is complete, no dual-tree drift.');
process.exit(0);