/* eslint-disable no-undef */
/**
 * qbTokenStore.js — thin QuickBooks adapter over the generic credential store.
 *
 * Maps QuickBooks OAuth token objects to the generic credential record
 * (lib/integrationCredentialStore.js) and back. It holds NO storage logic and
 * NO QuickBooks API logic — only the mapping and the QuickBooks-specific
 * "one active connected credential per environment" rule.
 *
 *   provider         = "intuit"
 *   credential_type  = "quickbooks"
 *   account_identifier = String(realm_id)   (stable QuickBooks company id)
 *
 * Storage selection, encryption, status validation, and production/filesystem
 * rules live entirely in integrationCredentialStore.js.
 *
 * Decrypted QuickBooks payload (inside encrypted_payload):
 *   { access_token, refresh_token, realm_id,
 *     access_token_expires_at, refresh_token_expires_at }
 *
 * expires_at (non-secret column) is mapped from access_token_expires_at so
 * future monitoring can query expiring credentials without decrypting.
 *
 * Facade consumed by server.js:
 *   loadPersistedTokens(environment)         -> QB token object | null
 *   savePersistedTokens(environment, tokens)  -> 'postgres' | 'filesystem'
 *   deletePersistedTokens(environment, realmId?) -> 'postgres' | 'filesystem' | 'none'
 *   markExpired(environment)                 -> 'expired' | null  (status change, no delete)
 *   markRevoked(environment)                 -> 'revoked' | null  (status change, no delete)
 *   canUseFilesystemFallback()               -> boolean
 *
 * Plaintext tokens are never logged. Status-change errors never include token
 * values (only the account_identifier is referenced).
 */
'use strict';

const store = require('./integrationCredentialStore');

const PROVIDER = 'intuit';
const CREDENTIAL_TYPE = 'quickbooks';

function tokensToArgs(environment, tokens) {
  if (!tokens || !tokens.realm_id) throw new Error('QuickBooks token object requires realm_id');
  const realmId = String(tokens.realm_id);
  return {
    provider: PROVIDER,
    credentialType: CREDENTIAL_TYPE,
    environment,
    accountIdentifier: realmId,
    displayName: tokens.display_name || ('QuickBooks realm ' + realmId),
    status: 'connected',
    expiresAt: tokens.expires_at, // access_token_expires_at (non-secret, for monitoring)
    payload: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      realm_id: tokens.realm_id,
      access_token_expires_at: tokens.expires_at,
      refresh_token_expires_at: tokens.refresh_expires_at,
    },
    connectedAt: tokens.connected_at || new Date().toISOString(),
    refreshedAt: tokens.last_refresh_at || null,
  };
}

function credentialToTokens(cred) {
  if (!cred) return null;
  const p = cred.payload || {};
  return {
    access_token: p.access_token,
    refresh_token: p.refresh_token,
    realm_id: p.realm_id,
    environment: cred.environment,
    expires_at: p.access_token_expires_at,
    refresh_expires_at: p.refresh_token_expires_at,
    connected_at: cred.connectedAt,
    last_refresh_at: cred.refreshedAt,
    display_name: cred.displayName,
    status: cred.status,
    credential_expires_at: cred.expiresAt,
    key_version: cred.keyVersion,
    last_used_at: cred.lastUsedAt,
    last_error_at: cred.lastErrorAt,
  };
}

function key(realmId) {
  return { provider: PROVIDER, credentialType: CREDENTIAL_TYPE, accountIdentifier: String(realmId) };
}

// Startup: load the active connected QuickBooks credential for the environment
// WITHOUT knowing realm_id (one active per env; rejects if multiple).
async function loadPersistedTokens(environment) {
  const cred = await store.loadActiveCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment });
  return credentialToTokens(cred);
}

// Initial OAuth callback or refresh rotation. account_identifier = realm_id.
async function savePersistedTokens(environment, tokens) {
  await store.saveCredential(tokensToArgs(environment, tokens));
  return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
}

// Disconnect: delete the stored QuickBooks credential. When realm_id is known,
// delete by exact key. When unknown, resolve the single connected credential
// for the environment and delete it only if exactly one exists (refuse if many).
async function deletePersistedTokens(environment, realmId) {
  if (realmId) {
    await store.deleteCredential({ ...key(realmId), environment });
  } else {
    const cred = await store.loadActiveCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment });
    if (!cred) return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
    await store.deleteCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: cred.accountIdentifier });
  }
  return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
}

// Mark the active connected QuickBooks credential as expired/revoked WITHOUT
// deleting the row (audit + future re-auth flow). No token values are logged.
async function setActiveStatus(environment, status) {
  const cred = await store.loadActiveCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment });
  if (!cred) return null;
  await store.updateCredentialStatus({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: cred.accountIdentifier, status });
  return status;
}

function markExpired(environment) { return setActiveStatus(environment, 'expired'); }
function markRevoked(environment) { return setActiveStatus(environment, 'revoked'); }

// Record a successful authenticated QuickBooks request (updates last_used_at;
// does not modify connected_at/refreshed_at/created_at). Pass realmId to avoid
// an extra active-credential lookup. Never logs token values.
async function markUsed(environment, realmId) {
  if (!realmId) return null;
  await store.markCredentialUsed({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: String(realmId) });
  return 'used';
}

// Record an operational failure (invalid refresh token, revoked credential,
// authentication failure, transient timeout). Stores a sanitized message
// (truncated to 255 chars, no secrets). Does NOT change status — the caller
// decides whether to also call markRevoked (auth revoked) or leave status
// connected (transient timeout). Pass realmId to target a specific credential.
async function markError(environment, realmId, message) {
  if (!realmId) return null;
  await store.markCredentialError({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: String(realmId), message });
  return 'error';
}

function canUseFilesystemFallback() {
  return store.canUseFilesystemFallback();
}

module.exports = {
  PROVIDER,
  CREDENTIAL_TYPE,
  loadPersistedTokens,
  savePersistedTokens,
  deletePersistedTokens,
  markExpired,
  markRevoked,
  markUsed,
  markError,
  canUseFilesystemFallback,
  tokensToArgs,
  credentialToTokens,
};