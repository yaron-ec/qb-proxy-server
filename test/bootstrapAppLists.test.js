/* eslint-disable no-undef */
'use strict';

/**
 * bootstrapAppLists.test.js — scripts/install/bootstrap.js#ensureAppLists.
 *
 * PRODUCTIZATION: a fresh installation previously had NO supported way to
 * seed its own project types / lead sources / statuses / contact owners at
 * install time — app_settings('app_lists') was never written by bootstrap,
 * so a new company relied entirely on the frontend's hardcoded fallback
 * constants (themselves fixed elsewhere to be generic, not EC-specific).
 * This gives an operator an explicit, intentional way to seed real values
 * via company.json, while never overwriting an already-configured
 * installation's real saved settings on a repeat bootstrap run.
 *
 * DB access is mocked — no live database is used or required.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ensureAppLists } = require('../scripts/install/bootstrap');

function mockDb(existingAppListsRow) {
  const inserted = { value: null };
  return {
    inserted,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT value FROM app_settings/i.test(s)) {
        return { rows: existingAppListsRow ? [{ value: existingAppListsRow }] : [] };
      }
      if (/^INSERT INTO app_settings/i.test(s)) {
        inserted.value = JSON.parse(params[0]);
        return { rows: [] };
      }
      throw new Error('unexpected query in mock: ' + s);
    },
  };
}

test('no project_types/lead_sources/statuses/contact_owners provided: writes nothing', async () => {
  const db = mockDb(null);
  const result = await ensureAppLists(db, {});
  assert.strictEqual(result.created, false);
  assert.strictEqual(db.inserted.value, null);
});

test('project_types + lead_sources provided, no existing row: seeds app_lists with exactly the provided values', async () => {
  const db = mockDb(null);
  const result = await ensureAppLists(db, {
    project_types: ['Kitchen Remodel', 'Roofing'],
    lead_sources: ['Website', 'Referral'],
  });
  assert.strictEqual(result.created, true);
  assert.deepStrictEqual(db.inserted.value, {
    projectTypes: ['Kitchen Remodel', 'Roofing'],
    sources: ['Website', 'Referral'],
  });
});

test('all four fields provided: all four keys written', async () => {
  const db = mockDb(null);
  await ensureAppLists(db, {
    project_types: ['Kitchen Remodel'],
    lead_sources: ['Website'],
    statuses: ['New', 'Sold'],
    contact_owners: ['Jordan Admin'],
  });
  assert.deepStrictEqual(db.inserted.value, {
    projectTypes: ['Kitchen Remodel'],
    sources: ['Website'],
    statuses: ['New', 'Sold'],
    contactOwners: ['Jordan Admin'],
  });
});

test('REGRESSION: an already-existing app_lists row is NEVER overwritten by bootstrap, even with new config values', async () => {
  const db = mockDb({ sources: ['already here'] });
  const result = await ensureAppLists(db, { lead_sources: ['Website', 'Referral'] });
  assert.strictEqual(result.created, false);
  assert.strictEqual(db.inserted.value, null, 'no INSERT should ever run when app_lists already exists');
});
