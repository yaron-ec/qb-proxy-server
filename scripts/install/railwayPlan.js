/* eslint-disable no-undef */
'use strict';

/**
 * railwayPlan.js — PRODUCTIZATION, Company Provisioning System, Phase C
 * (Railway deployment automation audit).
 *
 * WHAT IS AND ISN'T AUTOMATED, AND WHY:
 *
 * Railway does not publish a stable, documented-for-third-party-scripting
 * REST/CLI surface for "create a new project with N services from a GitHub
 * repo and set their env vars" that this repository could safely drive
 * without the OPERATOR'S OWN Railway account credentials (an API token tied
 * to their account/team, which this repo must never hold, generate, or
 * invent — see CLAUDE.md's Security Model). Even with a real token supplied
 * via an env var at runtime, actually creating billable cloud
 * infrastructure is exactly the kind of external, costly, hard-to-reverse
 * action that needs the operator's own explicit go-ahead in the moment, not
 * a one-shot script run unattended — so this module deliberately does NOT
 * call any Railway API. It does the one thing that genuinely CAN be fully
 * automated and gets re-derived every install: figuring out, from this
 * installation's own config, exactly which Railway services it needs
 * (never more than it needs — see "Do NOT duplicate obsolete Railway
 * services" in docs/INSTALL_NEW_COMPANY.md) and the exact settings each one
 * needs, so an operator (or a future, explicitly-authorized automation
 * layer with the operator's own token) has a precise, correct plan instead
 * of having to reverse-engineer one from railway.json (which is EC's OWN
 * deployment template — see its header comment — not a generic one).
 *
 * The canonical, manually-verified service topology this is built from is
 * CLAUDE.md's "Production topology" table — NOT railway.json's own
 * `_worker_isolation_notes` guesses, which have been wrong before (see
 * docs/PRODUCTION_ARCHITECTURE.md's correction).
 */

function computeRequiredServices(cfg) {
  const enabled = cfg.enabled_modules || {};
  const needsCalendarWorker = enabled.google_calendar === true || enabled.google_contacts === true;

  return [
    {
      id: 'api',
      role: 'Backend API',
      required: true,
      dockerfile: 'Dockerfile',
      startCommand: "sh -c 'node db/migrate.js && node server.js'",
      healthcheckPath: '/health',
      reason: 'Always required — serves every authenticated and public API route.',
    },
    {
      id: 'frontend',
      role: 'Frontend CRM SPA',
      required: true,
      dockerfile: 'crm-frontend/Dockerfile',
      reason: 'Always required — this IS the product\'s UI.',
    },
    {
      id: 'postgres',
      role: 'PostgreSQL database',
      required: true,
      managed: true,
      reason: 'Always required — the one database for this installation (single-tenant-per-deployment model).',
    },
    {
      id: 'reminder-worker',
      role: 'Reminder worker (appointment/follow-up/task reminder emails)',
      required: null, // operator decision, not derivable from enabled_modules — see reason
      dockerfile: 'Dockerfile.worker',
      startCommand: 'node reminderWorker.js',
      reason: 'There is no enabled_modules flag for reminders (a known, documented gap — see docs/CONFIGURATION_REFERENCE.md). Deploy this service if the company wants automated reminder emails sent at all; omit it (or set REMINDER_DRY_RUN=true on it) otherwise. The core CRM works fully without it.',
    },
    {
      id: 'calendar-outbox-worker',
      role: 'Calendar / Google Contacts outbox worker',
      required: needsCalendarWorker,
      dockerfile: 'Dockerfile.worker',
      startCommand: 'node scripts/calendarOutboxWorker.js',
      reason: needsCalendarWorker
        ? 'google_calendar and/or google_contacts is enabled in this config — this worker processes their sync queues and is required for those modules to actually do anything.'
        : 'Neither google_calendar nor google_contacts is enabled in this config. This worker self-gates on both flags (see scripts/calendarOutboxWorker.js) and would do nothing useful if deployed — skip it to avoid paying for an idle service. Add it later if either module is turned on.',
    },
  ];
}

function renderDeploymentPlanMarkdown(cfg, services) {
  const lines = [
    `# Railway deployment plan — ${cfg.company_name || '(unnamed)'}`,
    '',
    'Railway does not offer a safe, documented way to automate project/service',
    'creation from this repository without the operator\'s own account token —',
    'see railwayPlan.js\'s header comment for why. These are the exact manual',
    'steps for THIS installation\'s own configuration.',
    '',
    '## 1. Create a new Railway project',
    '',
    `Name it for this company (e.g. "${cfg.company_name}") — do NOT reuse or add services to EC's own \`devoted-courtesy\` project.`,
    '',
    '## 2. Add these services',
    '',
  ];
  for (const svc of services) {
    if (svc.required === false) continue;
    const optionalNote = svc.required === null ? ' (OPTIONAL — operator decision, see note below)' : '';
    lines.push(`### ${svc.role}${optionalNote}`);
    if (svc.managed) {
      lines.push('- Add a Railway-managed PostgreSQL database to this project. `DATABASE_URL` is then set automatically on every service in the project.');
    } else {
      lines.push(`- Source: this GitHub repository (same branch/commit for every service)`);
      lines.push(`- Dockerfile: \`${svc.dockerfile}\``);
      if (svc.startCommand) lines.push(`- Start command: \`${svc.startCommand}\``);
      if (svc.healthcheckPath) lines.push(`- Health check path: \`${svc.healthcheckPath}\``);
    }
    lines.push(`- ${svc.reason}`);
    lines.push('');
  }
  const skipped = services.filter((s) => s.required === false);
  if (skipped.length) {
    lines.push('## Not needed for this installation');
    lines.push('');
    for (const svc of skipped) {
      lines.push(`- **${svc.role}**: ${svc.reason}`);
    }
    lines.push('');
  }
  lines.push('## 3. Set environment variables');
  lines.push('');
  lines.push('See `env.manifest.txt` (written alongside this file) for the full list — never commit it, never paste real secret values into this document.');
  lines.push('');
  lines.push('## 4. Configure watch paths (multi-service repo)');
  lines.push('');
  lines.push('Without watch paths, a push to the branch redeploys EVERY service in the project even when only one service\'s files changed. Configure each service\'s watch paths in the Railway dashboard — see `railway.json`\'s own `watchPaths` entries (EC\'s own deployment template) for the exact file lists per service type.');
  return lines.join('\n');
}

module.exports = { computeRequiredServices, renderDeploymentPlanMarkdown };
