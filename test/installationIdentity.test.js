/* eslint-disable no-undef */
'use strict';

/**
 * installationIdentity.test.js — regression coverage for
 * lib/installationIdentity.js, the safety gate that stops a maintenance
 * script from running against the wrong company's database under the
 * productized single-tenant-per-deployment model.
 *
 * DB access is mocked (require.cache substitution for db/client) — no live
 * database is used or required.
 */
const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../db/client');
let queryImpl = async () => ({ rows: [] });
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...a) => queryImpl(...a) } };

const { identify, requireInstallationConfirmation } = require('../lib/installationIdentity');

test('identify(): no company_settings row → configured=false, both ids null', async () => {
  queryImpl = async () => ({ rows: [] });
  const id = await identify();
  assert.deepStrictEqual(id, { installationId: null, companyName: null, configured: false });
});

test('identify(): returns the singleton row\'s installation_id + company_name', async () => {
  queryImpl = async () => ({ rows: [{ installation_id: 'abc-123', company_name: 'Acme Remodeling' }] });
  const id = await identify();
  assert.deepStrictEqual(id, { installationId: 'abc-123', companyName: 'Acme Remodeling', configured: true });
});

test('requireInstallationConfirmation: missing --confirm-installation throws, never proceeds', async () => {
  queryImpl = async () => ({ rows: [{ installation_id: 'abc-123', company_name: 'Acme Remodeling' }] });
  await assert.rejects(() => requireInstallationConfirmation([], { log: () => {} }), /Refusing to proceed/);
});

test('requireInstallationConfirmation: wrong id/name throws, never proceeds', async () => {
  queryImpl = async () => ({ rows: [{ installation_id: 'abc-123', company_name: 'Acme Remodeling' }] });
  await assert.rejects(
    () => requireInstallationConfirmation(['--confirm-installation=some-other-company'], { log: () => {} }),
    /does not match the connected database/
  );
});

test('requireInstallationConfirmation: matching installation_id resolves', async () => {
  queryImpl = async () => ({ rows: [{ installation_id: 'abc-123', company_name: 'Acme Remodeling' }] });
  const id = await requireInstallationConfirmation(['--confirm-installation=abc-123'], { log: () => {} });
  assert.strictEqual(id.installationId, 'abc-123');
});

test('requireInstallationConfirmation: matching company_name (case-insensitive) resolves', async () => {
  queryImpl = async () => ({ rows: [{ installation_id: 'abc-123', company_name: 'Acme Remodeling' }] });
  const id = await requireInstallationConfirmation(['--confirm-installation=ACME REMODELING'], { log: () => {} });
  assert.strictEqual(id.companyName, 'Acme Remodeling');
});

test('requireInstallationConfirmation: an unbootstrapped database (no row) can still be confirmed by name for the FIRST bootstrap run — but a plain missing flag still throws', async () => {
  queryImpl = async () => ({ rows: [] });
  await assert.rejects(() => requireInstallationConfirmation([], { log: () => {} }), /Refusing to proceed/);
});
