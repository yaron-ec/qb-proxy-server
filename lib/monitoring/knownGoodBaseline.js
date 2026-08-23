/* eslint-disable no-undef */
/**
 * knownGoodBaseline — tracks the last verified-healthy commit and deployment
 * for every production-critical service. Used by the recovery policy to decide
 * whether a rollback is safe.
 *
 * Baseline is ONLY promoted after a newly deployed release passes all required
 * health checks. It is never auto-promoted on deploy alone.
 *
 * Seed: devoted-courtesy / qb-proxy-server begins at commit
 *   2fe2ffeb9dc122dd00c92d423f492c35b5d006b5
 */
'use strict';

const db = require('../db/client');
const { getService } = require('./serviceInventory');

async function getBaseline(serviceId) {
  const { rows } = await db.query(
    `SELECT * FROM monitoring_known_good WHERE service_id = $1`,
    [serviceId]
  );
  if (rows[0]) return rows[0];
  // Fall back to seed from service inventory
  const svc = getService(serviceId);
  if (svc && svc.knownGoodCommit) {
    return { service_id: serviceId, commit_sha: svc.knownGoodCommit, deployment_id: null, last_healthy_at: null };
  }
  return null;
}

async function verifyAndPromote(serviceId, commitSha, deploymentId, healthResult) {
  if (!healthResult || !healthResult.healthy) {
    return { promoted: false, reason: 'Health check failed — baseline not promoted' };
  }
  await db.query(
    `INSERT INTO monitoring_known_good (service_id, commit_sha, deployment_id, last_healthy_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (service_id) DO UPDATE SET
       commit_sha = EXCLUDED.commit_sha,
       deployment_id = EXCLUDED.deployment_id,
       last_healthy_at = EXCLUDED.last_healthy_at,
       updated_at = NOW()`,
    [serviceId, commitSha, deploymentId]
  );
  return { promoted: true, commitSha, deploymentId };
}

async function getLastHealthyTime(serviceId) {
  const baseline = await getBaseline(serviceId);
  return baseline?.last_healthy_at || null;
}

module.exports = { getBaseline, verifyAndPromote, getLastHealthyTime };