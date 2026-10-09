/* eslint-disable no-undef */
/**
 * platformRailway.js — Railway Public API (GraphQL v2) client for AUTOMATED
 * company infrastructure provisioning (PRODUCTIZATION — Company Provisioning
 * System, automated infrastructure).
 *
 * DELIBERATELY SEPARATE from lib/monitoring/railwayApiClient.js, which is the
 * production watchdog's own, already-verified-live client (restart/rollback/
 * disconnect for EC's EXISTING services) — this file never imports or
 * modifies that one, so nothing here can affect the watchdog's production
 * behavior. The two files duplicate a small `gql()` helper rather than share
 * one; that duplication is the price of never risking watchdog-critical code
 * for a brand-new, much less battle-tested feature.
 *
 * VERIFICATION STATUS (be honest about this, always): every mutation shape
 * below is built from Railway's documented GraphQL schema and from
 * third-party/community reports of its actual behavior — this repository's
 * sandbox has no outbound access to Railway and no RAILWAY_API_TOKEN, so
 * NONE of this has been exercised against a real Railway account. In
 * particular, community reports describe `serviceCreate` with a GitHub repo
 * source attached in one call as unreliable ("Problem processing request");
 * this client therefore creates a service in two steps (empty service, then
 * attach source) to match the community-reported workaround — but that
 * workaround is itself unverified here. Treat every function in this file as
 * "implemented against the best available spec, pending one supervised
 * dry run against a disposable Railway project with a real token" — see the
 * final report in the PR this shipped with for exactly what that dry run
 * should check before trusting this for a real customer.
 *
 * SAFETY: every write call in this module requires RAILWAY_API_TOKEN to be
 * set — see isConfigured(). Nothing here is ever called unless an operator
 * has deliberately generated and configured that token (a one-time, human,
 * Railway-dashboard action — see docs/INSTALL_NEW_COMPANY.md's "Automated
 * infrastructure" section). The token itself is never logged, never
 * returned in any API response, and never written to any company's own
 * database.
 */
'use strict';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

function getToken() {
  return process.env.RAILWAY_API_TOKEN || '';
}

function isConfigured() {
  return !!getToken();
}

async function gql(query, variables = {}) {
  const token = getToken();
  if (!token) throw new Error('RAILWAY_API_TOKEN not set — automated infrastructure provisioning is disabled on this installation');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }

  if (parsed.errors) {
    const msg = parsed.errors.map((e) => e.message).join('; ');
    throw new Error(`Railway API error: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`Railway API HTTP ${res.status}: ${parsed.raw || text.slice(0, 300)}`);
  }
  return parsed.data || {};
}

/** Creates a new Railway project for one company. Returns { id, name }. */
async function createProject(name) {
  const data = await gql(
    `mutation projectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }`,
    { input: { name } }
  );
  return data.projectCreate;
}

/** Looks up a project's default ("production") environment id. */
async function getDefaultEnvironment(projectId) {
  const data = await gql(
    `query project($id: String!) {
      project(id: $id) { id environments { edges { node { id name } } } }
    }`,
    { id: projectId }
  );
  const envs = data.project?.environments?.edges?.map((e) => e.node) || [];
  const prod = envs.find((e) => e.name === 'production') || envs[0];
  if (!prod) throw new Error(`Railway project ${projectId} has no environment yet`);
  return prod;
}

/**
 * Adds a managed Postgres database to a project/environment. Railway
 * provisions this as a "plugin" service; its connection string becomes
 * available as that service's own DATABASE_URL variable a few seconds after
 * creation — callers should poll getServiceVariables() rather than assume
 * it's immediately present.
 */
async function createPostgres(projectId, environmentId) {
  const data = await gql(
    `mutation pluginCreate($input: PluginCreateInput!) {
      pluginCreate(input: $input) { id name }
    }`,
    { input: { projectId, environmentId, name: 'postgresql' } }
  );
  return data.pluginCreate;
}

/** Step 1 of service creation: an empty service with no source attached yet. */
async function createEmptyService(projectId, name) {
  const data = await gql(
    `mutation serviceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    { input: { projectId, name } }
  );
  return data.serviceCreate;
}

/**
 * Step 2: attaches this SAME shared GitHub repo to an already-created,
 * empty service — never a per-company fork/repo (see docs/
 * INSTALL_NEW_COMPANY.md's "one shared codebase" architecture). `branch` is
 * this company's own deploy/<slug> ref (see lib/platformRelease.js), never
 * `main` directly, so a push to main never redeploys a company on its own —
 * only an explicit, admin-triggered rollout does.
 */
async function connectServiceSource(serviceId, { repo, branch, rootDirectory, dockerfilePath }) {
  const data = await gql(
    `mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
      serviceConnect(id: $id, input: $input) { id }
    }`,
    { id: serviceId, input: { repo, branch } }
  );
  // Root directory / Dockerfile path are per-service deploy settings, set in
  // a separate call so a failure here doesn't require re-attaching source.
  await gql(
    `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) { id }
    }`,
    { serviceId, environmentId: undefined, input: { rootDirectory, dockerfilePath } }
  ).catch((e) => {
    // Non-fatal: root/dockerfile can also be set manually in the Railway
    // dashboard if this particular mutation shape doesn't match live Railway
    // — never let an uncertain secondary call abort an otherwise-successful
    // service connection.
    throw Object.assign(new Error(`service connected but deploy settings may need manual review: ${e.message}`), { nonFatal: true });
  });
  return data.serviceConnect;
}

/** Sets (or overwrites) a batch of environment variables on one service. */
async function upsertVariables(projectId, environmentId, serviceId, variables) {
  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    { input: { projectId, environmentId, serviceId, variables } }
  );
}

/** Reads back a service's current variables (used to retrieve Postgres's own generated DATABASE_URL). */
async function getServiceVariables(projectId, environmentId, serviceId) {
  const data = await gql(
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { projectId, environmentId, serviceId }
  );
  return data.variables || {};
}

/** Generates (or returns the existing) *.up.railway.app public domain for a service. */
async function generateDomain(environmentId, serviceId) {
  const data = await gql(
    `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
    { input: { environmentId, serviceId } }
  );
  return data.serviceDomainCreate?.domain || null;
}

/** Triggers a fresh deployment for a service (used once source + variables are set). */
async function deployService(serviceId, environmentId) {
  const data = await gql(
    `mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    { serviceId, environmentId }
  );
  return data.serviceInstanceDeploy;
}

/** Latest deployment status for a service (for polling after a deploy/rollout trigger). */
async function getLatestDeploymentStatus(serviceId, environmentId) {
  const data = await gql(
    `query deployments($input: DeploymentListInput!) {
      deployments(input: $input, first: 1) { edges { node { id status createdAt } } }
    }`,
    { input: { serviceId, environmentId } }
  );
  return data.deployments?.edges?.[0]?.node || null;
}

module.exports = {
  isConfigured,
  createProject,
  getDefaultEnvironment,
  createPostgres,
  createEmptyService,
  connectServiceSource,
  upsertVariables,
  getServiceVariables,
  generateDomain,
  deployService,
  getLatestDeploymentStatus,
};
