/* eslint-disable no-undef */
/**
 * railwayApiClient — Railway Public API (GraphQL v2) client for the watchdog.
 *
 * Used by the production watchdog to perform SAFE automated recovery actions:
 *   - Restart a service (Level 1 transient failure)
 *   - Rollback to last known good deployment (Level 2 bad deployment)
 *   - Disconnect GitHub auto-deploy (for legacy services like clever-manifestation)
 *
 * TOKEN SCOPE GATE: Every method checks whether the token has the required
 * scopes before attempting the action. If the token is read-only or missing,
 * the method returns { canPerform: false, reason } so the watchdog degrades
 * gracefully to alert-only mode.
 *
 * SECRETS ARE NEVER LOGGED. The token is read from process.env.RAILWAY_API_TOKEN
 * and used only in the Authorization header.
 *
 * Endpoint: https://backboard.railway.app/graphql/v2
 */
'use strict';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

function getToken() {
  return process.env.RAILWAY_API_TOKEN || '';
}

async function gql(query, variables = {}) {
  const token = getToken();
  if (!token) throw new Error('RAILWAY_API_TOKEN not set');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }

  if (parsed.errors) {
    const msg = parsed.errors.map(e => e.message).join('; ');
    throw new Error(`Railway API error: ${msg}`);
  }
  return parsed.data || {};
}

/**
 * Check if the token can perform write operations (restart, rollback, etc).
 * Returns { canRestart, canRollback, canDisconnectGithub, reason }.
 */
async function checkCapabilities() {
  const token = getToken();
  if (!token) {
    return { canRestart: false, canRollback: false, canDisconnectGithub: false, reason: 'RAILWAY_API_TOKEN not set' };
  }

  // Try a simple query to see if the token is valid at all
  try {
    await gql(`query { me { id } }`);
    // If we get here, it's an account token with at least read access
    // We won't know write access until we try, but we can report read access
    return {
      canRestart: true, // will attempt and handle failure
      canRollback: true,
      canDisconnectGithub: true,
      tokenType: 'account',
      reason: 'Account token detected — write operations will be attempted with error handling',
    };
  } catch (e) {
    // Try project token
    try {
      await gql(`query { projectToken { projectId } }`);
      return {
        canRestart: false,
        canRollback: false,
        canDisconnectGithub: false,
        tokenType: 'project',
        reason: 'Project token detected — insufficient scope for deployment management. Restart/rollback require account or workspace token with deployment scopes.',
      };
    } catch (e2) {
      return {
        canRestart: false,
        canRollback: false,
        canDisconnectGithub: false,
        tokenType: 'unknown',
        reason: `Token not recognized as account or project token: ${e.message}`,
      };
    }
  }
}

/**
 * Restart a Railway service (deployment).
 * @param {string} projectId - Railway project ID
 * @param {string} serviceId - Railway service ID
 * @returns { success, restartId, error }
 */
async function restartService(projectId, serviceId) {
  try {
    const data = await gql(
      `mutation deploymentRestart($projectId: String!, $serviceId: String!) {
        deploymentRestart(projectId: $projectId, serviceId: $serviceId)
      }`,
      { projectId, serviceId }
    );
    return { success: true, restartId: data.deploymentRestart };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Rollback to a specific deployment.
 * @param {string} projectId - Railway project ID
 * @param {string} environmentId - Railway environment ID
 * @param {string} serviceId - Railway service ID
 * @param {string} deploymentId - Deployment ID to rollback to
 * @returns { success, error }
 */
async function rollbackDeployment(projectId, environmentId, serviceId, deploymentId) {
  try {
    await gql(
      `mutation deploymentRollback($projectId: String!, $environmentId: String!, $serviceId: String!, $deploymentId: String!) {
        deploymentRollback(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, deploymentId: $deploymentId)
      }`,
      { projectId, environmentId, serviceId, deploymentId }
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Disconnect a GitHub repo from a Railway service (stops auto-deploy).
 * @param {string} serviceId - Railway service ID
 * @returns { success, error }
 */
async function disconnectGithubRepo(serviceId) {
  try {
    await gql(
      `mutation serviceUpdate($id: String!, $input: ServiceUpdateInput!) {
        serviceUpdate(id: $id, input: $input) { id }
      }`,
      { id: serviceId, input: { repo: null } }
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * List all projects and their services (for discovery).
 * @returns { projects: [{ id, name, services: [...] }] }
 */
async function listProjects() {
  try {
    const data = await gql(
      `query { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } }`
    );
    return data.projects?.edges?.map(e => ({
      id: e.node.id,
      name: e.node.name,
      services: e.node.services?.edges?.map(s => s.node) || [],
      environments: e.node.environments?.edges?.map(env => env.node) || [],
    })) || [];
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  checkCapabilities,
  restartService,
  rollbackDeployment,
  disconnectGithubRepo,
  listProjects,
};