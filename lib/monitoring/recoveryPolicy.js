/* eslint-disable no-undef */
/**
 * recoveryPolicy — decides what automatic recovery is safe for a given failure.
 *
 * LEVEL 1 — TRANSIENT PROCESS FAILURE:
 *   Deployment was previously healthy, no new code, process exited unexpectedly.
 *   → Allow one controlled Railway restart. Recheck health. Do not restart
 *   indefinitely (crash-loop detector caps at 3 failures / 10 min).
 *
 * LEVEL 2 — BAD NEW DEPLOYMENT:
 *   Service was healthy before, a NEW commit/deployment fails build/startup/
 *   health. Previous deployment confirmed healthy.
 *   → Prepare rollback to LAST KNOWN GOOD deployment — ONLY if:
 *     (a) Railway API supports reliable rollback,
 *     (b) no incompatible DB migration occurred since the known-good commit,
 *     (c) previous deployment is compatible with current schema.
 *   If DB compatibility cannot be proven → DO NOT auto-rollback → alert instead.
 *
 * LEVEL 3 — DO NOT AUTO-FIX (always escalate):
 *   MODULE_NOT_FOUND, missing env var, schema mismatch, OAuth disconnected,
 *   credential error, migration required, unknown startup exception.
 *   → Collect evidence → alert → keep service safe.
 *
 * This module RETURNS DECISIONS only. It does not perform restarts or rollbacks.
 * The operator or a separate executor service acts on the decision.
 */
'use strict';

const ESCALATION_ERRORS = [
  'MODULE_NOT_FOUND',
  'Cannot find module',
  'ENCRYPTION_KEY not set',
  'not set in environment',
  'database schema mismatch',
  'does not exist',
  'OAuth',
  'credential',
  'unauthorized',
  'migration required',
  'ECONNREFUSED', // DB down — restart won't help
  'ENOTFOUND',
];

function isEscalationError(errorSummary) {
  const lower = (errorSummary || '').toLowerCase();
  return ESCALATION_ERRORS.some(e => lower.includes(e.toLowerCase()));
}

function evaluateRecovery(serviceId, failureInfo) {
  const { errorSummary, isCrashLoop, isNewIncident, previousHealthy } = failureInfo;

  // LEVEL 3 — never auto-fix these
  if (isEscalationError(errorSummary)) {
    return {
      action: 'escalate',
      reason: `Error pattern requires manual investigation: ${errorSummary?.slice(0, 100)}`,
      operatorActionRequired: true,
    };
  }

  // Crash loop — stop restarting, escalate
  if (isCrashLoop) {
    return {
      action: 'escalate',
      reason: `Crash loop detected (3+ failures in 10 min). Stopping blind restarts.`,
      operatorActionRequired: true,
    };
  }

  // LEVEL 1 — transient failure on previously-healthy service
  if (isNewIncident && previousHealthy && !isEscalationError(errorSummary)) {
    return {
      action: 'restart',
      reason: 'Transient failure on previously-healthy service. One controlled restart permitted.',
      maxRestarts: 1,
      operatorActionRequired: false,
    };
  }

  // LEVEL 2 — bad new deployment (rollback candidate)
  // NOTE: Auto-rollback is NOT enabled by default. Railway API token lacks
  // deployment management scopes. This returns 'rollback_candidate' so the
  // operator can manually roll back via the Railway dashboard.
  if (isNewIncident && !previousHealthy) {
    return {
      action: 'rollback_candidate',
      reason: 'New deployment may be bad. Manual rollback recommended via Railway dashboard.',
      operatorActionRequired: true,
    };
  }

  // Default: escalate
  return {
    action: 'escalate',
    reason: 'Unknown failure pattern. Manual investigation required.',
    operatorActionRequired: true,
  };
}

module.exports = { evaluateRecovery, isEscalationError, ESCALATION_ERRORS };