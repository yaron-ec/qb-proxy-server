/* eslint-disable no-undef */
'use strict';

/**
 * bootstrapCompanySettings.test.js — scripts/install/bootstrap.js#ensureCompanySettings.
 *
 * Regression: a fresh install (no existing company_settings row) that omits
 * admin_name — documented as optional in this script's own header comment —
 * used to write an explicit NULL into default_owner_name (NOT NULL,
 * see db/migrations/2026-47-notification-config.sql), crashing bootstrap.
 * Fixed to fall back to a neutral 'Admin' placeholder — never null, and
 * never silently omitting the column (which would let the column's own
 * EC-preserving DEFAULT ('Yaron Drilevich') apply instead, breaking
 * Company #2 isolation for a fresh install).
 *
 * DB access is mocked — no live database is used or required.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ensureCompanySettings } = require('../scripts/install/bootstrap');

function mockDb(existingRow) {
  const inserted = { cols: null, vals: null };
  return {
    inserted,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT \* FROM company_settings/i.test(s)) {
        return { rows: existingRow ? [existingRow] : [] };
      }
      if (/^INSERT INTO company_settings/i.test(s)) {
        const cols = s.match(/\(([^)]+)\)/)[1].split(',').map((c) => c.trim());
        inserted.cols = cols;
        inserted.vals = params;
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        row.installation_id = row.installation_id || 'fake-installation-id';
        row.timezone = row.timezone || 'America/Los_Angeles';
        return { rows: [row] };
      }
      throw new Error('unexpected query in mock: ' + s);
    },
  };
}

test('no existing row + no admin_name: default_owner_name is a neutral placeholder, never null, never crashes', async () => {
  const db = mockDb(null);
  const result = await ensureCompanySettings(db, {
    company_name: 'NoAdminName Co', admin_email: 'owner@noadminname.example', admin_password: 'x',
  });
  assert.strictEqual(result.created, true);
  const nameIdx = db.inserted.cols.indexOf('default_owner_name');
  assert.notStrictEqual(nameIdx, -1, 'default_owner_name must be explicitly written (never omitted — that would inherit the EC column default)');
  assert.strictEqual(db.inserted.vals[nameIdx], 'Admin');
  assert.notStrictEqual(db.inserted.vals[nameIdx], null);
  assert.notStrictEqual(db.inserted.vals[nameIdx], 'Yaron Drilevich');

  const emailIdx = db.inserted.cols.indexOf('default_owner_email');
  assert.strictEqual(db.inserted.vals[emailIdx], 'owner@noadminname.example');
});

test('no existing row + admin_name provided: default_owner_name uses the real admin name, not the placeholder', async () => {
  const db = mockDb(null);
  await ensureCompanySettings(db, {
    company_name: 'Acme', admin_name: 'Jordan Admin', admin_email: 'jordan@acme.example', admin_password: 'x',
  });
  const nameIdx = db.inserted.cols.indexOf('default_owner_name');
  assert.strictEqual(db.inserted.vals[nameIdx], 'Jordan Admin');
});

test('no existing row + no admin_email + no company_email: throws a clear error instead of inserting an invalid/null default_owner_email', async () => {
  const db = mockDb(null);
  await assert.rejects(
    () => ensureCompanySettings(db, { company_name: 'NoContactEmail Co' }),
    /contact email is required/,
  );
});

test('no existing row + no admin_email but company_email present: falls back to company_email', async () => {
  const db = mockDb(null);
  await ensureCompanySettings(db, { company_name: 'Acme', company_email: 'hello@acme.example' });
  const emailIdx = db.inserted.cols.indexOf('default_owner_email');
  assert.strictEqual(db.inserted.vals[emailIdx], 'hello@acme.example');
});

test('existing row: idempotent short-circuit, never re-inserts', async () => {
  const existing = { id: 'existing-id', company_name: 'Already Bootstrapped Co', installation_id: 'existing-installation-id', timezone: 'America/Chicago' };
  const db = mockDb(existing);
  const result = await ensureCompanySettings(db, { company_name: 'Should Not Matter' });
  assert.strictEqual(result.created, false);
  assert.strictEqual(result.row, existing);
  assert.strictEqual(db.inserted.cols, null, 'no INSERT should ever run when a row already exists');
});
