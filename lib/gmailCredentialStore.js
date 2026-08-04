/* eslint-disable no-undef */
/**
 * gmailCredentialStore.js — thin Gmail adapter over the generic credential store.
 *
 * Maps Gmail OAuth credentials to the generic credential record
 * (lib/integrationCredentialStore.js) and back. It holds NO storage logic and
 * NO Gmail API logic — only the mapping and the Gmail-specific "one active
 * connected credential per environment" rule.
 *
 *   provider           = "google"
 *   credential_type    = "gmail"
 *   account_identifier = the sending Gmail address (yaron@ecconstructiongroup.com)
 *
 * Storage selection, encryption, status validation, and production/filesystem
 * rules live entirely in integrationCredentialStore.js.
 *
 * Decrypted Gmail payload (inside encrypted_payload):
 *   { client_id, client_secret, refresh_token, access_token?,
 *     access_token_expires_at?, refresh_token_expires_at? }
 *
 * expires_at (non-secret column) is mapped from access_token_expires_at so
 * monitoring can query expiring credentials without decrypting. key_version is
 * preserved on load and re-save.
 *
 * Facade consumed by lib/gmailSender.js:
 *   loadGmailCredential(environment)                     -> Gmail cred object | null
 *   saveGmailCredential(environment, tokens)              -> 'postgres' | 'filesystem'
 *   deleteGmailCredential(environment, accountIdentifier?) -> 'postgres' | 'filesystem' | 'none'
 *   markUsed(environment, accountIdentifier)             -> 'used' | null
 *   markError(environment, accountIdentifier, message)   -> 'error' | null
 *   canUseFilesystemFallback()                           -> boolean
 *
 * Plaintext tokens are never logged. Errors never include token values (only
 * the account_identifier is referenced).
 */
'use strict';

const store = require('./integrationCredentialStore');

const PROVIDER = 'google';
const CREDENTIAL_TYPE = 'gmail';
const DEFAULT_ACCOUNT = 'yaron@ecconstructiongroup.com';

function tokensToArgs(environment, tokens) {
  if (!tokens) throw new Error('Gmail token object required');
  const accountIdentifier = String(tokens.account_identifier || tokens.email || DEFAULT_ACCOUNT).toLowerCase();
  return {
    provider: PROVIDER,
    credentialType: CREDENTIAL_TYPE,
    environment,
    accountIdentifier,
    displayName: tokens.display_name || ('Gmail ' + accountIdentifier),
    status: 'connected',
    expiresAt: tokens.access_token_expires_at || null,
    payload: {
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token || null,
      access_token_expires_at: tokens.access_token_expires_at || null,
      refresh_token_expires_at: tokens.refresh_token_expires_at || null,
    },
    connectedAt: tokens.connected_at || new Date().toISOString(),
    refreshedAt: tokens.refreshed_at || null,
  };
}

function credentialToTokens(cred) {
  if (!cred) return null;
  const p = cred.payload || {};
  return {
    client_id: p.client_id,
    client_secret: p.client_secret,
    refresh_token: p.refresh_token,
    access_token: p.access_token || null,
    access_token_expires_at: p.access_token_expires_at || null,
    refresh_token_expires_at: p.refresh_token_expires_at || null,
    account_identifier: cred.accountIdentifier,
    environment: cred.environment,
    display_name: cred.displayName,
    status: cred.status,
    connected_at: cred.connectedAt,
    refreshed_at: cred.refreshedAt,
    key_version: cred.keyVersion,
    last_used_at: cred.lastUsedAt,
    last_error_at: cred.lastErrorAt,
  };
}

function key(accountIdentifier) {
  return { provider: PROVIDER, credentialType: CREDENTIAL_TYPE, accountIdentifier: String(accountIdentifier || DEFAULT_ACCOUNT).toLowerCase() };
}

// Load the active connected Gmail credential for the environment (one active per env).
async function loadGmailCredential(environment) {
  const cred = await store.loadActiveCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment });
  return credentialToTokens(cred);
}

// Save (initial OAuth or rotation). account_identifier = sending Gmail address.
async function saveGmailCredential(environment, tokens) {
  await store.saveCredential(tokensToArgs(environment, tokens));
  return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
}

// Delete the stored Gmail credential. By exact account when known; else the single active one.
async function deleteGmailCredential(environment, accountIdentifier) {
  if (accountIdentifier) {
    await store.deleteCredential({ ...key(accountIdentifier), environment });
  } else {
    const cred = await store.loadActiveCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment });
    if (!cred) return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
    await store.deleteCredential({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: cred.accountIdentifier });
  }
  return process.env.DATABASE_URL ? 'postgres' : 'filesystem';
}

async function markUsed(environment, accountIdentifier) {
  if (!accountIdentifier) return null;
  await store.markCredentialUsed({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: String(accountIdentifier).toLowerCase() });
  return 'used';
}

async function markError(environment, accountIdentifier, message) {
  if (!accountIdentifier) return null;
  await store.markCredentialError({ provider: PROVIDER, credentialType: CREDENTIAL_TYPE, environment, accountIdentifier: String(accountIdentifier).toLowerCase(), message });
  return 'error';
}

function canUseFilesystemFallback() {
  return store.canUseFilesystemFallback();
}

module.exports = {
  PROVIDER,
  CREDENTIAL_TYPE,
  DEFAULT_ACCOUNT,
  loadGmailCredential,
  saveGmailCredential,
  deleteGmailCredential,
  markUsed,
  markError,
  canUseFilesystemFallback,
  tokensToArgs,
  credentialToTokens,
};