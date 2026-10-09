/* eslint-disable no-undef */
/**
 * platformRelease.js — centrally managed release / staged rollout / rollback
 * engine (PRODUCTIZATION — Company Provisioning System, automated
 * infrastructure + release pipeline).
 *
 * THE CORE MECHANISM: every company's Railway services are connected not to
 * `main` (which only EC's OWN services track, exactly as before this
 * feature existed) but to a per-company branch in this SAME shared repo —
 * `deploy/<company_slug>` (see lib/platformInfraProvisioning.js, which
 * creates it at provisioning time). Railway's existing, already-working
 * github-push-triggers-redeploy behavior is the ONLY thing that actually
 * redeploys a company's services — this module's whole job is deciding
 * WHEN to move that company's branch pointer forward (or back), never
 * calling any Railway "redeploy" API directly. This is what makes rollout
 * "centrally managed" instead of "every company redeploys the instant
 * anyone pushes to main": a push to main moves nothing by itself.
 *
 * No new GitHub credential is required for this — it uses the SAME
 * already-authorized `gh api` access this session already has to this
 * exact repo (see environment notes); there is deliberately no per-company
 * GitHub connection or separate repo (the task's own explicit requirement).
 *
 * Safety: rolloutRelease() NEVER auto-starts from a git push — it is only
 * ever invoked by an explicit admin action (routes/platformReleases.js),
 * matching "do not deploy to production until I explicitly approve".
 */
'use strict';

const { execFileSync } = require('child_process');
const { query } = require('../db/client');

function getPlatformRepo() {
  const { getPlatformRepo: get } = require('./platformInfraProvisioning');
  return get();
}

function ghApi(args) {
  const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 15000 });
  try { return JSON.parse(out); } catch { return out; }
}

/** Creates a company's deploy branch if it doesn't exist yet, or moves it (force) to `sha` if it does. Idempotent either way. */
function ensureDeployBranch(repo, branch, sha) {
  try {
    ghApi(['-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
    return { created: true };
  } catch (e) {
    if (!/Reference already exists/i.test(e.message) && !/422/.test(e.message)) throw e;
    ghApi(['-X', 'PATCH', `repos/${repo}/git/refs/heads/${branch}`, '-f', `sha=${sha}`, '-F', 'force=true']);
    return { created: false, moved: true };
  }
}

/** This server's own currently-deployed commit — Railway auto-injects this on every service. The default, always-vetted release sha: "roll out what I'm already running", never an arbitrary/unreviewed one. */
function getCurrentPlatformReleaseSha() {
  return process.env.RAILWAY_GIT_COMMIT_SHA || null;
}

async function createRelease({ gitSha, gitRef, createdBy, batchSize, notes }) {
  const sha = gitSha || getCurrentPlatformReleaseSha();
  if (!sha) throw new Error('No git_sha provided and RAILWAY_GIT_COMMIT_SHA is not set on this process — cannot determine what "current" means');
  const { rows } = await query(
    `INSERT INTO platform_releases (git_sha, git_ref, batch_size, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [sha, gitRef || null, batchSize || 1, notes || null, createdBy || null]
  );
  return rows[0];
}

async function listReleases() {
  const { rows } = await query(`SELECT * FROM platform_releases ORDER BY created_at DESC`);
  return rows;
}

// Overridable ONLY for fast unit tests (no real deploy is ever this quick) —
// production always uses the real defaults below.
const DEFAULT_POLL_ATTEMPTS = Number(process.env.PLATFORM_HEALTH_POLL_ATTEMPTS) || 10;
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.PLATFORM_HEALTH_POLL_INTERVAL_MS) || 6000;

async function pollHealth(backendUrl, { attempts = DEFAULT_POLL_ATTEMPTS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { healthy: true };
    } catch (_) { /* not up yet */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { healthy: false };
}

async function alertAdmins(subject, bodyText) {
  try {
    const { getProtectedAdminEmails } = require('./notificationRecipients');
    const emails = [...(await getProtectedAdminEmails())];
    if (!emails.length) return;
    const emailService = require('./emailService');
    await Promise.all(emails.map((to) => emailService.send({ to, subject, htmlBody: `<pre>${bodyText}</pre>` })));
  } catch (e) {
    console.warn('[platformRelease] alert email failed (non-fatal):', e.message);
  }
}

/**
 * Moves ONE company's deploy branch to `targetSha`, waits for health, and
 * records the outcome. Returns the platform_company_deployments row.
 */
async function deployCompanyToSha(company, releaseId, targetSha) {
  const repo = getPlatformRepo();
  const { rows: insRows } = await query(
    `INSERT INTO platform_company_deployments (company_id, release_id, previous_release_sha, target_release_sha, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [company.id, releaseId, company.current_release_sha, targetSha]
  );
  const deployment = insRows[0];
  try {
    ensureDeployBranch(repo, company.deploy_branch, targetSha);
    await query(`UPDATE platform_company_deployments SET status = 'deployed' WHERE id = $1`, [deployment.id]);
    const { healthy } = await pollHealth(company.backend_url);
    if (!healthy) throw new Error(`${company.company_name}'s backend did not become healthy after deploying ${targetSha.slice(0, 8)}`);
    await query(`UPDATE platform_company_deployments SET status = 'healthy', completed_at = NOW() WHERE id = $1`, [deployment.id]);
    await query(`UPDATE platform_companies SET current_release_sha = $1, last_deploy_status = 'healthy', last_deploy_at = NOW(), updated_at = NOW() WHERE id = $2`, [targetSha, company.id]);
    return { ...deployment, status: 'healthy' };
  } catch (e) {
    await query(`UPDATE platform_company_deployments SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`, [e.message, deployment.id]);
    await query(`UPDATE platform_companies SET last_deploy_status = 'failed', updated_at = NOW() WHERE id = $1`, [company.id]);
    throw e;
  }
}

/**
 * Rolls a single company back to its OWN previous release sha (from its
 * most recent deployment row) — never a different company's, never a
 * guess. Used both for the automatic halt-and-rollback inside
 * rolloutRelease() and for an admin-triggered manual rollback.
 */
async function rollbackCompany(companyId) {
  const { rows: companyRows } = await query('SELECT * FROM platform_companies WHERE id = $1', [companyId]);
  const company = companyRows[0];
  if (!company) throw new Error('company not found');
  const { rows: lastDeployRows } = await query(
    `SELECT * FROM platform_company_deployments WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [companyId]
  );
  const last = lastDeployRows[0];
  if (!last || !last.previous_release_sha) {
    throw new Error('no previous release recorded for this company — nothing to roll back to');
  }
  const repo = getPlatformRepo();
  ensureDeployBranch(repo, company.deploy_branch, last.previous_release_sha);
  const { healthy } = await pollHealth(company.backend_url);
  await query(
    `INSERT INTO platform_company_deployments (company_id, release_id, previous_release_sha, target_release_sha, status, completed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [companyId, last.release_id, company.current_release_sha, last.previous_release_sha, healthy ? 'rolled_back' : 'failed']
  );
  await query(`UPDATE platform_companies SET current_release_sha = $1, last_deploy_status = $2, last_deploy_at = NOW(), updated_at = NOW() WHERE id = $3`, [last.previous_release_sha, healthy ? 'rolled_back' : 'failed', companyId]);
  if (!healthy) throw new Error(`Rolled ${company.company_name} back to ${last.previous_release_sha.slice(0, 8)} but it did not become healthy`);
  return { company_id: companyId, rolled_back_to: last.previous_release_sha };
}

/**
 * Staged rollout: companies ordered by creation date, processed in batches.
 * A batch only starts once the previous one is fully healthy. The FIRST
 * unhealthy company in a batch triggers an automatic rollback of just that
 * company, halts the whole release (status='halted', no further batches),
 * and alerts the platform admins — never silently continues past a broken
 * deploy, and never leaves one company down while the rest move on.
 */
async function rolloutRelease(releaseId, { batchSize } = {}) {
  const { rows: releaseRows } = await query('SELECT * FROM platform_releases WHERE id = $1', [releaseId]);
  const release = releaseRows[0];
  if (!release) throw new Error('release not found');
  const size = batchSize || release.batch_size || 1;

  await query(`UPDATE platform_releases SET status = 'rolling_out', updated_at = NOW() WHERE id = $1`, [releaseId]);

  const { rows: companies } = await query(
    `SELECT * FROM platform_companies
     WHERE status IN ('invited','activated') AND deploy_branch IS NOT NULL
     ORDER BY created_at ASC`
  );

  const results = [];
  for (let i = 0; i < companies.length; i += size) {
    const batch = companies.slice(i, i + size);
    for (const company of batch) {
      try {
        const deployment = await deployCompanyToSha(company, releaseId, release.git_sha);
        results.push({ company_id: company.id, company_name: company.company_name, status: deployment.status });
      } catch (e) {
        results.push({ company_id: company.id, company_name: company.company_name, status: 'failed', error: e.message });
        await query(`UPDATE platform_releases SET status = 'halted', updated_at = NOW() WHERE id = $1`, [releaseId]);
        let rollbackNote = 'not attempted';
        try {
          await rollbackCompany(company.id);
          rollbackNote = 'rolled back successfully';
        } catch (rbErr) {
          rollbackNote = `rollback ALSO failed: ${rbErr.message}`;
        }
        await alertAdmins(
          `Release rollout halted — ${company.company_name} failed`,
          `Release ${release.id} (${release.git_sha}) failed health check on ${company.company_name}: ${e.message}\nRollback: ${rollbackNote}\nRemaining companies were NOT deployed — investigate before re-running rollout.`
        );
        return { release_id: releaseId, status: 'halted', results, halted_on: company.company_name, rollback: rollbackNote };
      }
    }
  }

  await query(`UPDATE platform_releases SET status = 'completed', updated_at = NOW() WHERE id = $1`, [releaseId]);
  return { release_id: releaseId, status: 'completed', results };
}

module.exports = {
  getPlatformRepo,
  ensureDeployBranch,
  getCurrentPlatformReleaseSha,
  createRelease,
  listReleases,
  rolloutRelease,
  rollbackCompany,
  deployCompanyToSha,
};
