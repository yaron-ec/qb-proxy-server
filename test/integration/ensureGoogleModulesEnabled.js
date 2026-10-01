/* eslint-disable no-undef */
'use strict';

/**
 * ensureGoogleModulesEnabled — shared setup helper for integration test
 * files that exercise real Google Calendar/Contacts sync end-to-end
 * (booking → calendar_outbox → worker → fake Google client).
 *
 * PRODUCTIZATION background: lib/booking/calendarOutbox.js's
 * enqueueCreate/enqueueUpdate, lib/googleContactsOutbox.js's
 * enqueueContactSync, and scripts/calendarOutboxWorker.js's tick() now all
 * gate on company_settings.enabled_modules.google_calendar/google_contacts
 * (see CLAUDE.md's module-gating notes). Before that gating existed, these
 * test files never needed to care what company_settings held, because
 * nothing read it to decide whether to actually sync. Now they do.
 *
 * `npm run test:integration` shares ONE database and ONE company_settings
 * singleton (read via `ORDER BY created_at ASC LIMIT 1`, see
 * lib/companyConfig.js) across every file in the run — a design already
 * documented in CLAUDE.md ("share one database... which each file drains").
 * A fresh, unbootstrapped database has ZERO company_settings rows, which
 * makes companyConfig fall back to PRODUCT_DEFAULTS — every module
 * disabled, a deliberately conservative default for an installation that
 * hasn't been configured yet (see lib/companyConfig.js's own comment: "a
 * real installation always has a row by the time it serves traffic"). A
 * file that runs before any other file has created a row, or after some
 * other file's own scoped test left a narrower enabled_modules value in
 * place, would otherwise see google_calendar/google_contacts as OFF and
 * silently stop syncing — not a bug in the gating itself, just this test
 * fixture never having had to assert the precondition it was always
 * implicitly relying on.
 *
 * This helper makes that precondition explicit: it ensures the effective
 * singleton row (inserting a neutral placeholder if none exists yet) has
 * google_calendar=true and google_contacts=true, merging into whatever
 * enabled_modules the row already had rather than clobbering other keys,
 * and returns enough state to restore the prior value afterward so a run
 * of the full suite leaves company_settings exactly as any other file
 * would have found it.
 */
async function ensureGoogleModulesEnabled(db) {
  const existing = (await db.query(
    'SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1'
  )).rows[0];

  if (!existing) {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, enabled_modules)
       VALUES ($1, $2) RETURNING id`,
      [`Integration Test Co ${Date.now()}`, JSON.stringify({ google_calendar: true, google_contacts: true })]
    );
    return { insertedId: ins.rows[0].id };
  }

  const previous = existing.enabled_modules || {};
  const needsUpdate = !previous.google_calendar || !previous.google_contacts;
  if (needsUpdate) {
    const merged = Object.assign({}, previous, { google_calendar: true, google_contacts: true });
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(merged), existing.id]);
  }
  return { existingId: existing.id, previous, changed: needsUpdate };
}

async function restoreGoogleModules(db, state) {
  if (!state) return;
  if (state.insertedId) {
    await db.query('DELETE FROM company_settings WHERE id = $1', [state.insertedId]);
  } else if (state.changed) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(state.previous), state.existingId]);
  }
}

module.exports = { ensureGoogleModulesEnabled, restoreGoogleModules };
