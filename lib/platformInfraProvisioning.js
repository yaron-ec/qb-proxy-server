/* eslint-disable no-undef */
/**
 * platformInfraProvisioning.js — fully automated company infrastructure
 * provisioning (PRODUCTIZATION — Company Provisioning System, automated
 * infrastructure + release pipeline).
 *
 * Two entry points:
 *   estimateInfrastructure(cfg)  — PURE, no network/DB calls. Computes which
 *     Railway services this company needs (reuses scripts/install/
 *     railwayPlan.js's own derivation, never a second copy of that logic)
 *     and an approximate monthly cost range from Railway's published
 *     per-resource metering rates. Used to show the platform admin a cost
 *     estimate BEFORE anything is created — see "Do not automatically
 *     create billable Railway infrastructure... until I explicitly approve
 *     the estimated cost" in the task this shipped with.
 *
 *   provisionInfrastructure(row, cfg) — the actual automation, gated on
 *     lib/platformRailway.js#isConfigured() (RAILWAY_API_TOKEN present) and
 *     on the caller having already recorded cost_confirmed_at (routes/
 *     platformCompanies.js enforces both before calling this). A RESUMABLE
 *     step machine: each step is checked against row.provisioning_state
 *     before running, so a retry after a mid-flight failure (Railway's own
 *     API is documented-unreliable for some of these calls — see
 *     lib/platformRailway.js's header) never re-creates a resource that
 *     already exists and never double-charges for infrastructure. Progress
 *     is persisted to platform_companies.provisioning_state after EVERY
 *     step, by the caller (routes/platformCompanies.js), via the onProgress
 *     callback — this module itself holds no database connection of its
 *     own beyond what's passed in.
 *
 * Reuses, unmodified: lib/platformProvisioning.js#provisionCompanyDatabase
 * (the existing, already-isolated DB-level engine from the original manual
 * onboarding workflow) for the "run migrations + bootstrap the new
 * company's own database" step — this file is a new CALLER of it, not a
 * second implementation.
 */
'use strict';

const crypto = require('crypto');
const railwayPlan = require('../scripts/install/railwayPlan');
const railway = require('./platformRailway');

// Approximate monthly USD cost per service, from Railway's published
// per-resource metering (roughly $20/vCPU-month, $10/GB RAM-month, small
// egress/storage) applied to a realistic light-usage estimate for each
// service's typical footprint. Railway has no API for a hard per-project
// spending cap — actual cost tracks real usage, so this is a planning
// estimate, never a guarantee. Always re-check Railway's own current
// pricing page before relying on this for a real budget decision.
const COST_TABLE_USD = {
  api: { low: 8, high: 15 },
  frontend: { low: 2, high: 5 },
  postgres: { low: 5, high: 12 },
  'reminder-worker': { low: 3, high: 6 },
  'calendar-outbox-worker': { low: 3, high: 6 },
};

function estimateInfrastructure(cfg) {
  const services = railwayPlan.computeRequiredServices(cfg);
  // 'required: null' (reminder-worker) is an operator decision with no
  // enabled_modules signal to derive it from — default the ESTIMATE to
  // including it (most companies want reminder emails), but the admin can
  // decline it before confirming; required:false is never included.
  const included = services.filter((s) => s.required !== false);
  const breakdown = included.map((s) => {
    const cost = COST_TABLE_USD[s.id] || { low: 3, high: 8 };
    return { id: s.id, role: s.role, optional: s.required === null, low_usd: cost.low, high_usd: cost.high };
  });
  const low = breakdown.reduce((sum, b) => sum + b.low_usd, 0);
  const high = breakdown.reduce((sum, b) => sum + b.high_usd, 0);
  return {
    services: breakdown,
    estimated_monthly_usd_low: low,
    estimated_monthly_usd_high: high,
    currency: 'USD',
    basis: 'Approximate, from Railway\'s published per-resource metering rates (CPU/RAM/egress/storage) for a light-usage new company. Actual cost tracks real usage — Railway has no API for a hard spending cap. Re-verify against Railway\'s own current pricing before budgeting a real customer.',
  };
}

// 'invite' is deliberately NOT one of these — sending the owner's invite
// email is the caller's job (routes/platformCompanies.js), shared with the
// original manual provisioning path, after this function returns
// dbReport.first_admin.invite_token. Tracked via the company's own status
// column (same as the manual flow), not via provisioning_state.
const STEP_ORDER = ['project', 'environment', 'postgres', 'services', 'variables', 'domains', 'deploy', 'health', 'database'];

function isStepDone(state, step) {
  return !!(state?.completed_steps || []).includes(step);
}

function freshSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Resolves this installation's own repo (owner/repo) that every company's
 * Railway services get connected to — the ONE shared codebase, never a
 * per-company fork. Configured once, platform-wide, as PLATFORM_GITHUB_REPO
 * (e.g. "yaron-ec/qb-proxy-server") — never guessed from a local .git
 * directory, which does not exist inside a deployed container.
 */
function getPlatformRepo() {
  const repo = process.env.PLATFORM_GITHUB_REPO;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error('PLATFORM_GITHUB_REPO not configured (expected "owner/repo") — required for automated infrastructure provisioning');
  }
  return repo;
}

const SERVICE_DEPLOY_SPEC = {
  api: { dockerfilePath: 'Dockerfile', rootDirectory: '.' },
  frontend: { dockerfilePath: 'crm-frontend/Dockerfile', rootDirectory: '.' },
  'reminder-worker': { dockerfilePath: 'Dockerfile.worker', rootDirectory: '.' },
  'calendar-outbox-worker': { dockerfilePath: 'Dockerfile.worker', rootDirectory: '.' },
};

/**
 * Runs (or resumes) the full automated infrastructure provisioning for one
 * company. `row` is the company's current platform_companies record
 * (including any prior provisioning_state); `cfg` is the same
 * company-config shape scripts/install/bootstrap.js already consumes.
 * `onProgress(stepName, patch)` is called after every successfully
 * completed step so the caller can persist it immediately — a crash
 * between two steps therefore loses at most one step of progress, never
 * more, and never leaves an ambiguous "maybe-created" resource unrecorded.
 *
 * Returns the final patch to persist plus { ok, health_checks,
 * first_admin } from the reused DB-provisioning step, matching
 * lib/platformProvisioning.js#provisionCompanyDatabase's own return shape.
 */
async function provisionInfrastructure(row, cfg, onProgress) {
  if (!railway.isConfigured()) {
    throw new Error('RAILWAY_API_TOKEN not set — automated infrastructure provisioning is disabled on this installation (fall back to the manual "Mark Infrastructure Ready" flow, or configure RAILWAY_API_TOKEN to enable automation)');
  }
  const repo = getPlatformRepo();
  const state = row.provisioning_state && typeof row.provisioning_state === 'object' ? row.provisioning_state : {};
  const done = new Set(state.completed_steps || []);
  const record = async (step, patch) => {
    done.add(step);
    const nextState = { completed_steps: [...done], updated_at: new Date().toISOString() };
    await onProgress(step, { provisioning_state: nextState, ...patch });
    return nextState;
  };

  let projectId = row.railway_project_id;
  if (!done.has('project')) {
    const project = await railway.createProject(`${cfg.company_name} (${row.company_slug})`);
    projectId = project.id;
    await record('project', { railway_project_id: projectId });
  }

  let environmentId = row.railway_environment_id;
  if (!done.has('environment')) {
    const env = await railway.getDefaultEnvironment(projectId);
    environmentId = env.id;
    await record('environment', { railway_environment_id: environmentId });
  }

  let databaseUrl = null;
  if (!done.has('postgres')) {
    const pg = await railway.createPostgres(projectId, environmentId);
    // Railway takes a few seconds to materialize the generated DATABASE_URL
    // variable on a freshly created Postgres plugin — bounded poll, not a
    // fixed sleep, so a fast provision doesn't wait longer than it needs to.
    let vars = {};
    for (let i = 0; i < 20; i++) {
      vars = await railway.getServiceVariables(projectId, environmentId, pg.id);
      if (vars.DATABASE_URL) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!vars.DATABASE_URL) throw new Error('Postgres created but DATABASE_URL was not available after 30s — check the Railway dashboard before retrying');
    databaseUrl = vars.DATABASE_URL;
    const { encryptPayload } = require('./integrationCredentialStore');
    await record('postgres', { database_url_encrypted: encryptPayload({ database_url: databaseUrl }) });
  } else if (row.database_url_encrypted) {
    const { decryptPayload } = require('./integrationCredentialStore');
    databaseUrl = decryptPayload(row.database_url_encrypted).database_url;
  }

  const services = railwayPlan.computeRequiredServices(cfg).filter((s) => s.required !== false);
  const serviceIds = { ...(row.railway_service_ids || {}) };
  const deployBranch = row.deploy_branch || `deploy/${row.company_slug}`;
  if (!done.has('services')) {
    // Create (or confirm) this company's OWN deploy branch BEFORE connecting
    // any Railway service to it — see lib/platformRelease.js's header for
    // why every company tracks its own deploy/<slug> ref instead of `main`.
    // Its first value is whatever this platform server is itself currently
    // running (RAILWAY_GIT_COMMIT_SHA) — the one sha already vetted by
    // reaching EC's own production.
    const { ensureDeployBranch, getCurrentPlatformReleaseSha } = require('./platformRelease');
    const initialSha = getCurrentPlatformReleaseSha();
    if (initialSha) ensureDeployBranch(repo, deployBranch, initialSha);
    for (const svc of services) {
      if (serviceIds[svc.id]) continue; // already created on a prior partial run
      const created = await railway.createEmptyService(projectId, svc.id);
      const spec = SERVICE_DEPLOY_SPEC[svc.id];
      await railway.connectServiceSource(created.id, { repo, branch: deployBranch, ...spec }).catch((e) => {
        if (!e.nonFatal) throw e;
      });
      serviceIds[svc.id] = created.id;
    }
    await record('services', { railway_service_ids: serviceIds, deploy_branch: deployBranch });
  }

  if (!done.has('variables')) {
    const jwtSecret = freshSecret();
    const encryptionKey = freshSecret();
    const proxySecret = freshSecret();
    const sharedVars = {
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: 'false',
      RAILWAY_JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: encryptionKey,
      PROXY_SECRET: proxySecret,
    };
    for (const svc of services) {
      if (!serviceIds[svc.id]) continue;
      await railway.upsertVariables(projectId, environmentId, serviceIds[svc.id], sharedVars);
    }
    await record('variables', {});
  }

  let frontendUrl = row.frontend_url;
  let backendUrl = row.backend_url;
  if (!done.has('domains')) {
    if (serviceIds.frontend) frontendUrl = `https://${await railway.generateDomain(environmentId, serviceIds.frontend)}`;
    if (serviceIds.api) backendUrl = `https://${await railway.generateDomain(environmentId, serviceIds.api)}`;
    await record('domains', { frontend_url: frontendUrl, backend_url: backendUrl });
    // CRM_PUBLIC_URL depends on the domain just generated — set it now,
    // after the domain step, rather than guessing it during 'variables'.
    if (serviceIds.api) await railway.upsertVariables(projectId, environmentId, serviceIds.api, { CRM_PUBLIC_URL: frontendUrl });
    if (serviceIds.frontend) await railway.upsertVariables(projectId, environmentId, serviceIds.frontend, { VITE_API_BASE_URL: backendUrl });
  }

  if (!done.has('deploy')) {
    for (const id of Object.values(serviceIds)) {
      await railway.deployService(id, environmentId);
    }
    await record('deploy', {});
  }

  if (!done.has('health')) {
    if (!backendUrl) throw new Error('No backend_url to health-check — the domains step did not complete');
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { healthy = true; break; }
      } catch (_) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    if (!healthy) throw new Error(`Backend at ${backendUrl}/health did not become healthy within 2 minutes of deploying`);
    await record('health', {});
  }

  let dbReport = null;
  if (!done.has('database')) {
    const { provisionCompanyDatabase } = require('./platformProvisioning');
    // frontend_url/backend_url are only known now (generated during the
    // 'domains' step above) — the cfg the caller built before provisioning
    // started couldn't have had them yet.
    const dbCfg = { ...cfg, frontend_url: frontendUrl, backend_url: backendUrl };
    dbReport = await provisionCompanyDatabase({ databaseUrl, cfg: dbCfg });
    if (!dbReport.ok) throw new Error('Post-provision health checks failed on the new database — see dbReport for details');
    await record('database', {});
  }

  return { projectId, environmentId, serviceIds, frontendUrl, backendUrl, databaseUrl, dbReport, deployBranch };
}

module.exports = {
  estimateInfrastructure,
  provisionInfrastructure,
  STEP_ORDER,
  isStepDone,
  getPlatformRepo,
};
