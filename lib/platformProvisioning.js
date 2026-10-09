/* eslint-disable no-undef */
/**
 * platformProvisioning — drives the EXISTING, battle-tested, idempotent
 * company-provisioning engine (scripts/install/bootstrap.js,
 * scripts/install/companyConfigContract.js) against a brand-new company's
 * OWN, separate database, from a live request in the Company Management
 * API (routes/platformCompanies.js) — not a new provisioning
 * implementation, a new CALLER of the one that already exists.
 *
 * ISOLATION MODEL: every function here opens its own, temporary `pg.Pool`
 * connected to the TARGET company's `databaseUrl` (never this process's own
 * global `db.pool`, which stays connected to whichever installation THIS
 * server is actually deployed as — EC's own production database in
 * practice). The ad-hoc pool is always closed in a `finally` block. No
 * target-company data is ever read into, cached in, or copied from THIS
 * installation's own database — only a connection string (encrypted at
 * rest in platform_companies.database_url_encrypted) ever crosses the
 * boundary, and only for the duration of one explicit, admin-triggered
 * action (provision / resend-invite / suspend / activate). Routine request
 * traffic never touches this module.
 *
 * Reuses, unmodified:
 *   - db/client.js#applyBaseSchema      (the base schema.sql, idempotent)
 *   - db/migrate.js#runMigrationsOn     (the full migration chain, idempotent)
 *   - scripts/install/bootstrap.js's ensureCompanySettings/ensureFirstAdmin/
 *     ensureAppLists/ensureOwnerStartingLocation (all idempotent, all
 *     already parameterized by an explicit `db`-like object — never the
 *     global pool)
 */
'use strict';

const { Pool } = require('pg');

function openTargetPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
}

/**
 * Provisions (or re-provisions, idempotently) a brand-new company's own
 * database: migrations, company_settings, a PENDING first admin (no
 * password — see bootstrap.js#ensureFirstAdmin's optional admin_password
 * path), dropdown lists, owner starting location. Mirrors
 * scripts/install/provisionCompany.js's own DB-side steps exactly, just
 * invoked in-process against an ad-hoc pool instead of via a CLI subprocess
 * against process.env.DATABASE_URL.
 *
 * NEVER writes EC's (or this calling installation's) own data anywhere —
 * every value written comes from `cfg` (the admin's own form input) or from
 * bootstrap.js's product-generic defaults.
 *
 * @returns {{ ok, health_checks, first_admin: { created, email, invite_token } }}
 */
async function provisionCompanyDatabase({ databaseUrl, cfg }) {
  const pool = openTargetPool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      const { runMigrationsOn } = require('../db/migrate');
      await runMigrationsOn(client);
    } finally {
      client.release();
    }

    const bootstrap = require('../scripts/install/bootstrap');
    const targetDb = { query: (text, params) => pool.query(text, params) };

    const settingsResult = await bootstrap.ensureCompanySettings(targetDb, cfg);
    const adminResult = await bootstrap.ensureFirstAdmin(targetDb, cfg);
    const appListsResult = await bootstrap.ensureAppLists(targetDb, cfg);
    const ownerStartResult = await bootstrap.ensureOwnerStartingLocation(targetDb, cfg);

    // Post-provision health checks — never trust the steps above alone
    // (same discipline as scripts/install/provisionCompany.js's own
    // runHealthChecks, reimplemented here against the ad-hoc pool since
    // that function imports the GLOBAL db singleton, not an injectable one).
    const { rows: settingsRows } = await pool.query('SELECT * FROM company_settings ORDER BY created_at ASC LIMIT 1');
    const settings = settingsRows[0] || null;
    const { rows: adminRows } = await pool.query(`SELECT id, email, role FROM users WHERE role = 'admin'`);
    const { rows: migRows } = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    const health = {
      company_settings_row_exists: !!settings,
      company_name_matches: !!settings && settings.company_name === cfg.company_name,
      installation_id_present: !!settings?.installation_id,
      admin_count: adminRows.length,
      configured_admin_present: adminRows.some((u) => u.email?.toLowerCase() === (cfg.admin_email || '').toLowerCase()),
      migrations_applied: migRows[0].n,
      migrations_ok: migRows[0].n > 0,
    };
    health.ok = health.company_settings_row_exists && health.company_name_matches && health.migrations_ok && adminRows.length >= 1;

    return {
      ok: health.ok,
      health_checks: health,
      company_settings: { created: settingsResult.created, installation_id: settingsResult.row.installation_id },
      first_admin: {
        created: adminResult.created,
        email: adminResult.user?.email || null,
        invite_token: adminResult.inviteToken || null,
        reason: adminResult.reason || null,
      },
      app_lists: appListsResult,
      owner_starting_location: ownerStartResult,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Regenerates a fresh invite token for an existing (still password-less)
 * admin on the TARGET company's own database — "resend invite" after the
 * original link expired or was lost. Refuses (returns null) if that email
 * already has a real password (never silently re-invites an active account).
 */
async function regenerateInviteOnTarget({ databaseUrl, email }) {
  const pool = openTargetPool(databaseUrl);
  try {
    const crypto = require('crypto');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      `UPDATE users SET invite_token_hash = $1, invite_expires_at = $2, updated_at = NOW()
        WHERE lower(email) = lower($3) AND password_hash IS NULL
        RETURNING id, email, full_name`,
      [tokenHash, expiresAt, email]
    );
    if (!rows[0]) return null;
    return { user: rows[0], rawToken, expiresAt };
  } finally {
    await pool.end();
  }
}

/**
 * Suspend/activate a company — DIRECT action against the TARGET company's
 * OWN database (every one of its users' `status` flipped), never a runtime
 * flag the target installation's own server has to poll/consult. This is a
 * deliberate isolation choice: a company's running deployment must never
 * depend on reaching this (or any other) installation's database at
 * request time — see docs' "Enforce isolation" requirement. Suspension is
 * therefore enforced the same way any account disablement already is
 * (status = 'disabled' blocks login via authService#authenticatePassword
 * and the Google SSO status check in routes/auth.js's callback).
 */
async function setCompanyUsersStatus({ databaseUrl, status }) {
  if (!['active', 'disabled'].includes(status)) throw new Error('invalid status');
  const pool = openTargetPool(databaseUrl);
  try {
    const { rowCount } = await pool.query(`UPDATE users SET status = $1, updated_at = NOW()`, [status]);
    return { updated_users: rowCount };
  } finally {
    await pool.end();
  }
}

/** Read-only status probe against the target database — used by GET
 * /api/v1/platform/companies to show live counts without ever exposing
 * actual business records (counts only). */
async function probeCompanyDatabase({ databaseUrl }) {
  const pool = openTargetPool(databaseUrl);
  try {
    // A genuine connectivity failure (wrong credentials, unreachable host,
    // target database deleted) must surface as reachable:false. The three
    // business-data queries below each swallow their OWN failure (so a
    // table missing pre-migration doesn't sink the whole probe) — without
    // this separate check first, a totally unreachable database would also
    // have every one of those per-query catches fire and this function
    // would wrongly report reachable:true with all-null stats.
    await pool.query('SELECT 1');
    const [settings, users, leads] = await Promise.all([
      pool.query('SELECT company_name, installation_id FROM company_settings ORDER BY created_at ASC LIMIT 1').catch(() => ({ rows: [] })),
      pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE password_hash IS NULL AND google_sub IS NULL) ::int AS pending FROM users`).catch(() => ({ rows: [{ n: null, pending: null }] })),
      pool.query('SELECT count(*)::int AS n FROM leads').catch(() => ({ rows: [{ n: null }] })),
    ]);
    return {
      reachable: true,
      company_name: settings.rows[0]?.company_name || null,
      installation_id: settings.rows[0]?.installation_id || null,
      user_count: users.rows[0]?.n ?? null,
      pending_user_count: users.rows[0]?.pending ?? null,
      lead_count: leads.rows[0]?.n ?? null,
    };
  } catch (e) {
    return { reachable: false, error: e.message };
  } finally {
    await pool.end();
  }
}

module.exports = {
  provisionCompanyDatabase,
  regenerateInviteOnTarget,
  setCompanyUsersStatus,
  probeCompanyDatabase,
};
