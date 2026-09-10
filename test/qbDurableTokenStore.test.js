/* eslint-disable no-undef */
/**
 * Durable QuickBooks OAuth Token Storage Test Suite
 *
 * Verifies that QuickBooks OAuth tokens are stored in PostgreSQL
 * (integration_credentials table via integrationCredentialStore), NOT on the
 * ephemeral filesystem (.qb-tokens.encrypted).
 *
 * Requirements verified:
 *   1. Tokens stored in PostgreSQL (durable)
 *   2. Uses existing ENCRYPTION_KEY + integrationCredentialStore
 *   3. Stores: access_token, refresh_token, access_token_expires_at,
 *      refresh_token_expires_at, realm_id, environment, updated timestamp
 *   4. Never returns tokens to the frontend
 *   5. Never logs plaintext tokens
 *   6. Token refresh updates the durable record
 *   7. Concurrent refresh races prevented (mutex)
 *   8. No production dependency on .qb-tokens.encrypted
 *   9. Filesystem is only a one-time migration mechanism
 *   10. Zero Base44 dependency
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SERVER_PATH = path.join(__dirname, '../server.js');
const STORE_PATH = path.join(__dirname, '../lib/qbTokenStore.js');
const CREDENTIAL_STORE_PATH = path.join(__dirname, '../lib/integrationCredentialStore.js');
const MIGRATION_PATH = path.join(__dirname, '../db/migrations/2026-07-integration-credentials.sql');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
const credentialStoreSource = fs.readFileSync(CREDENTIAL_STORE_PATH, 'utf8');
const migrationSource = fs.readFileSync(MIGRATION_PATH, 'utf8');

console.log('Durable QB Token Storage Test Suite');
console.log('====================================');

// ── 1. PostgreSQL is the primary token store ──────────────────────────────

console.log('\n── PostgreSQL Primary Storage ──');

test('server.js uses tokenStore.loadPersistedTokens (not loadTokensFromFile)', () => {
  assert(serverSource.includes('tokenStore.loadPersistedTokens'), 'server.js must call tokenStore.loadPersistedTokens');
  assert(!serverSource.includes('function loadTokensFromFile'), 'server.js must NOT define loadTokensFromFile');
});

test('server.js uses tokenStore.savePersistedTokens (not saveTokensToFile)', () => {
  assert(serverSource.includes('tokenStore.savePersistedTokens'), 'server.js must call tokenStore.savePersistedTokens');
  assert(!serverSource.includes('function saveTokensToFile'), 'server.js must NOT define saveTokensToFile');
});

test('server.js uses tokenStore.deletePersistedTokens (not fs.unlinkSync)', () => {
  assert(serverSource.includes('tokenStore.deletePersistedTokens'), 'server.js must call tokenStore.deletePersistedTokens');
  // fs.unlinkSync may still appear in the migration function, but NOT in handleAuthDisconnect
  const disconnectMatch = serverSource.match(/async function handleAuthDisconnect[\s\S]*?^}/m);
  assert(disconnectMatch, 'handleAuthDisconnect must exist');
  assert(!disconnectMatch[0].includes('fs.unlinkSync'), 'handleAuthDisconnect must NOT use fs.unlinkSync');
});

test('server.js tokenStorageMethod is postgres (not filesystem)', () => {
  assert(serverSource.includes("tokenStorageMethod = 'postgres'"), 'tokenStorageMethod must be postgres');
  assert(!serverSource.includes("tokenStorageMethod = 'filesystem'"), 'tokenStorageMethod must NOT be filesystem');
});

test('buildHealthPayload returns storageMethod: postgres', () => {
  assert(serverSource.includes("storageMethod: 'postgres'"), 'buildHealthPayload must return storageMethod: postgres');
  assert(!serverSource.includes("storageMethod: 'filesystem'"), 'buildHealthPayload must NOT return storageMethod: filesystem');
});

// ── 2. Encryption + integrationCredentialStore ────────────────────────────

console.log('\n── Encryption & Credential Store ──');

test('qbTokenStore uses integrationCredentialStore', () => {
  assert(storeSource.includes("require('./integrationCredentialStore')"), 'qbTokenStore must require integrationCredentialStore');
});

test('integrationCredentialStore uses AES-256-CBC encryption', () => {
  assert(credentialStoreSource.includes('aes-256-cbc'), 'integrationCredentialStore must use aes-256-cbc');
  assert(credentialStoreSource.includes('ENCRYPTION_KEY'), 'integrationCredentialStore must use ENCRYPTION_KEY');
});

test('integrationCredentialStore uses PostgreSQL when DATABASE_URL is set', () => {
  assert(credentialStoreSource.includes('process.env.DATABASE_URL'), 'integrationCredentialStore must check DATABASE_URL');
  assert(credentialStoreSource.includes('pgSave'), 'integrationCredentialStore must have pgSave function');
});

test('integration_credentials table exists in migration', () => {
  assert(migrationSource.includes('CREATE TABLE IF NOT EXISTS integration_credentials'), 'migration must create integration_credentials table');
  assert(migrationSource.includes('encrypted_payload'), 'table must have encrypted_payload column');
  assert(migrationSource.includes('AES-256-CBC'), 'migration comment must mention AES-256-CBC');
});

// ── 3. Stored fields ───────────────────────────────────────────────────────

console.log('\n── Stored Token Fields ──');

test('qbTokenStore stores access_token', () => {
  assert(storeSource.includes('access_token'), 'qbTokenStore must store access_token');
});

test('qbTokenStore stores refresh_token', () => {
  assert(storeSource.includes('refresh_token'), 'qbTokenStore must store refresh_token');
});

test('qbTokenStore stores access_token_expires_at', () => {
  assert(storeSource.includes('access_token_expires_at'), 'qbTokenStore must store access_token_expires_at');
});

test('qbTokenStore stores refresh_token_expires_at', () => {
  assert(storeSource.includes('refresh_token_expires_at'), 'qbTokenStore must store refresh_token_expires_at');
});

test('qbTokenStore stores realm_id', () => {
  assert(storeSource.includes('realm_id'), 'qbTokenStore must store realm_id');
});

test('qbTokenStore stores environment', () => {
  assert(storeSource.includes('environment'), 'qbTokenStore must store environment');
});

test('qbTokenStore stores updated timestamp (refreshed_at)', () => {
  assert(storeSource.includes('refreshed_at'), 'qbTokenStore must store refreshed_at');
});

// ── 4. Never return tokens to frontend ─────────────────────────────────────

console.log('\n── No Token Leakage ──');

test('handleAuthCallback response does not include access_token', () => {
  const callbackMatch = serverSource.match(/async function handleAuthCallback[\s\S]*?^}/m);
  assert(callbackMatch, 'handleAuthCallback must exist');
  const resJsonMatch = callbackMatch[0].match(/res\.json\(\{[^}]+\}\)/);
  if (resJsonMatch) {
    assert(!resJsonMatch[0].includes('access_token'), 'res.json must NOT include access_token');
    assert(!resJsonMatch[0].includes('refresh_token'), 'res.json must NOT include refresh_token');
  }
});

test('handleAuthStatus response does not include access_token', () => {
  const statusMatch = serverSource.match(/async function handleAuthStatus[\s\S]*?^}/m);
  assert(statusMatch, 'handleAuthStatus must exist');
  assert(!statusMatch[0].includes('access_token'), 'handleAuthStatus must NOT include access_token');
  assert(!statusMatch[0].includes('refresh_token'), 'handleAuthStatus must NOT include refresh_token');
});

test('buildHealthPayload does not include access_token or refresh_token', () => {
  const healthMatch = serverSource.match(/async function buildHealthPayload[\s\S]*?^}/m);
  assert(healthMatch, 'buildHealthPayload must exist');
  assert(!healthMatch[0].includes('access_token'), 'buildHealthPayload must NOT include access_token');
  assert(!healthMatch[0].includes('refresh_token'), 'buildHealthPayload must NOT include refresh_token');
});

// ── 5. Never log plaintext tokens ──────────────────────────────────────────

console.log('\n── No Plaintext Token Logging ──');

test('no console.log includes access_token value', () => {
  // Check that no console.log statement includes access_token or refresh_token
  // as a variable to print (not just as a property name in an object)
  const logMatches = serverSource.match(/console\.(log|error|warn)\([^)]*\)/g) || [];
  for (const log of logMatches) {
    // Allow logs that reference token expiry timestamps (expires_at) but not the token itself
    assert(!log.includes('${tokens.access_token}'), `console.log must not print access_token: ${log}`);
    assert(!log.includes('${storedTokens.access_token}'), `console.log must not print access_token: ${log}`);
    assert(!log.includes('${tokens.refresh_token}'), `console.log must not print refresh_token: ${log}`);
    assert(!log.includes('${storedTokens.refresh_token}'), `console.log must not print refresh_token: ${log}`);
  }
});

// ── 6. Token refresh updates durable record ───────────────────────────────

console.log('\n── Refresh Updates Durable Record ──');

test('doRefreshToken calls saveTokensToStore (not saveTokensToFile)', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch, 'doRefreshToken must exist');
  assert(refreshMatch[0].includes('saveTokensToStore'), 'doRefreshToken must call saveTokensToStore');
  assert(!refreshMatch[0].includes('saveTokensToFile'), 'doRefreshToken must NOT call saveTokensToFile');
});

test('doRefreshToken persists after token rotation', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch[0].includes('await saveTokensToStore'), 'doRefreshToken must await saveTokensToStore');
});

// ── 7. Concurrent refresh race prevention ─────────────────────────────────

console.log('\n── Refresh Mutex ──');

test('server.js defines _refreshPromise mutex variable', () => {
  assert(serverSource.includes('let _refreshPromise'), 'server.js must define _refreshPromise');
});

test('doRefreshToken checks _refreshPromise before refreshing', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch[0].includes('if (_refreshPromise)'), 'doRefreshToken must check _refreshPromise mutex');
  assert(refreshMatch[0].includes('return _refreshPromise'), 'doRefreshToken must return existing promise');
});

test('doRefreshToken resets _refreshPromise in finally block', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch[0].includes('finally'), 'doRefreshToken must have a finally block');
  assert(refreshMatch[0].includes('_refreshPromise = null'), 'doRefreshToken must reset _refreshPromise in finally');
});

// ── 8. No production dependency on .qb-tokens.encrypted ────────────────────

console.log('\n── No Filesystem Production Dependency ──');

test('server.js does NOT have a module-level TOKEN_FILE constant', () => {
  // TOKEN_FILE may appear inside migrateFilesystemTokensIfNeeded (local const),
  // but NOT as a module-level const
  const moduleLevelTokenFile = serverSource.match(/^const TOKEN_FILE/m);
  assert(!moduleLevelTokenFile, 'server.js must NOT have module-level TOKEN_FILE const');
});

test('server.js does NOT have encryptToken/decryptToken functions', () => {
  assert(!serverSource.includes('function encryptToken'), 'server.js must NOT define encryptToken');
  assert(!serverSource.includes('function decryptToken'), 'server.js must NOT define decryptToken');
});

test('handleAuthDisconnect does NOT reference TOKEN_FILE', () => {
  const disconnectMatch = serverSource.match(/async function handleAuthDisconnect[\s\S]*?^}/m);
  assert(!disconnectMatch[0].includes('TOKEN_FILE'), 'handleAuthDisconnect must NOT reference TOKEN_FILE');
});

// ── 9. Filesystem is only a one-time migration ───────────────────────────

console.log('\n── Filesystem Migration Only ──');

test('server.js has migrateFilesystemTokensIfNeeded function', () => {
  assert(serverSource.includes('async function migrateFilesystemTokensIfNeeded'), 'server.js must have migrateFilesystemTokensIfNeeded');
});

test('migration function deletes filesystem file after migrating', () => {
  const migrateMatch = serverSource.match(/async function migrateFilesystemTokensIfNeeded[\s\S]*?^}/m);
  assert(migrateMatch, 'migrateFilesystemTokensIfNeeded must exist');
  assert(migrateMatch[0].includes('fs.unlinkSync'), 'migration must delete filesystem file');
});

test('migration function checks if PostgreSQL tokens already exist', () => {
  const migrateMatch = serverSource.match(/async function migrateFilesystemTokensIfNeeded[\s\S]*?^}/m);
  assert(migrateMatch[0].includes('loadPersistedTokens'), 'migration must check PostgreSQL first');
});

test('startup calls migration then loadTokensFromStore', () => {
  const listenMatch = serverSource.match(/app\.listen[\s\S]*?async \(\)[\s\S]*?{/);
  assert(listenMatch, 'app.listen must be async');
  const afterListen = serverSource.substring(listenMatch.index);
  assert(afterListen.includes('migrateFilesystemTokensIfNeeded'), 'startup must call migrateFilesystemTokensIfNeeded');
  assert(afterListen.includes('loadTokensFromStore'), 'startup must call loadTokensFromStore');
});

// ── 10. Zero Base44 dependency ─────────────────────────────────────────────

console.log('\n── Zero Base44 Dependency ──');

const filesToCheck = ['../server.js', '../lib/qbTokenStore.js', '../lib/integrationCredentialStore.js'];

for (const f of filesToCheck) {
  test(`${f} has zero Base44 runtime dependency`, () => {
    const source = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const hasBase44Call = source.includes('base44.functions') ||
                          source.includes('base44.entities') ||
                          source.includes('base44.auth') ||
                          source.includes('base44.integrations') ||
                          source.includes('base44.analytics') ||
                          source.includes("require('base44") ||
                          source.includes('require("@base44') ||
                          source.includes('from "@base44') ||
                          source.includes("from 'base44");
    assert(!hasBase44Call, `${f} must have zero Base44 runtime dependency`);
  });
}

// ── 11. Lifecycle tracking (markUsed/markError) ───────────────────────────

console.log('\n── Credential Lifecycle Tracking ──');

test('qbFetch calls tokenStore.markUsed on success', () => {
  const fetchMatch = serverSource.match(/async function qbFetch[\s\S]*?^}/m);
  assert(fetchMatch, 'qbFetch must exist');
  assert(fetchMatch[0].includes('tokenStore.markUsed'), 'qbFetch must call tokenStore.markUsed on success');
});

test('qbFetch calls tokenStore.markError on failure', () => {
  const fetchMatch = serverSource.match(/async function qbFetch[\s\S]*?^}/m);
  assert(fetchMatch[0].includes('tokenStore.markError'), 'qbFetch must call tokenStore.markError on failure');
});

test('doRefreshToken calls tokenStore.markRevoked on invalid_grant', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch[0].includes('tokenStore.markRevoked'), 'doRefreshToken must call markRevoked on invalid_grant');
});

test('doRefreshToken calls tokenStore.markError on refresh failure', () => {
  const refreshMatch = serverSource.match(/async function doRefreshToken[\s\S]*?^}/m);
  assert(refreshMatch[0].includes('tokenStore.markError'), 'doRefreshToken must call markError on failure');
});

// ── 12. getValidTokens loads from store ────────────────────────────────────

console.log('\n── getValidTokens Lazy Load ──');

test('getValidTokens calls loadTokensFromStore if not loaded', () => {
  const getValidMatch = serverSource.match(/async function getValidTokens[\s\S]*?^}/m);
  assert(getValidMatch, 'getValidTokens must exist');
  assert(getValidMatch[0].includes('loadTokensFromStore'), 'getValidTokens must call loadTokensFromStore');
  assert(getValidMatch[0].includes('_tokensLoaded'), 'getValidTokens must check _tokensLoaded flag');
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n===========================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}