# Backup & Restore (Productization — Phase I)

This is the general, per-installation backup/restore procedure. For EC's
own current disaster-recovery status (verified/not-verified state, RTO/RPO
figures), see `docs/DISASTER_RECOVERY.md` — that document is EC-specific
operational history and is not superseded by this one; this document
describes the procedure every installation, EC included, should follow.

## What gets backed up

- **Database (PostgreSQL, Railway-managed)** — Railway provides automated
  daily backups per its own retention policy. This covers all of an
  installation's data: `company_settings`, `users`, `leads`, `deals`,
  `integration_credentials` (encrypted), everything.
- **Code (GitHub)** — the canonical codebase is shared across every
  installation; there is nothing installation-specific to back up in git.
  An installation's actual running commit is whatever its Railway service
  is deployed from (see `docs/UPGRADE_RUNBOOK.md`'s versioning section).
- **Secrets (Railway environment variables)** — Railway does not version
  these. There is no code-level backup of an installation's env vars today;
  losing them (e.g. accidentally deleting a Railway service) means
  regenerating `RAILWAY_JWT_SECRET`/`ENCRYPTION_KEY` (which invalidates all
  existing sessions and makes previously-encrypted `integration_credentials`
  rows undecryptable) and reconnecting every integration from scratch. This
  is a real, documented gap — recommend operators keep their own secure
  record of each installation's secret values outside git (a password
  manager, not a text file), specifically to make this recoverable without
  a full integration-reconnect cycle.

## Restore procedure (per installation)

1. **Identify the target installation precisely.** Before restoring
   anything, confirm which Railway project/Postgres instance you are
   restoring — a restore performed against the wrong installation
   overwrites that installation's live data with another's backup. This is
   exactly the mistake `lib/installationIdentity.js`'s confirmation gate
   exists to catch for scripts; for a dashboard-driven Railway restore
   (which the gate cannot intercept, since it isn't a code path), the
   equivalent manual check is: after the restore point is chosen but before
   confirming, query the target's `company_settings.installation_id` /
   `company_name` from the restored point and verify it matches the
   installation you intend to restore, not another one.
2. Access the Railway dashboard for that specific project.
3. Select the Postgres service and choose the backup point to restore from.
4. Railway provisions a new Postgres instance from the backup.
5. Update that installation's `DATABASE_URL` environment variable to point
   to the new instance.
6. Restart that installation's API service (never another installation's).
7. **Post-restore verification:**
   - `GET /api/v1/system/info` (admin token) — confirm `installation.
     company_name`/`installation.installation_id` match the intended
     installation, confirm `schema.migrations_applied` matches what's
     expected for the code currently deployed (a restore from an older
     backup can restore an older schema — `node db/migrate.js` will bring
     it forward on next deploy/restart, since migrations are additive and
     safe to re-run).
   - Every integration will very likely need reconnecting after a restore
     older than its last token refresh: QuickBooks/Gmail/SignNow tokens in
     `integration_credentials` are only as fresh as the backup point, and
     Intuit in particular rotates the QuickBooks refresh token on every
     use — a restored, stale refresh token may already be invalid. Expect
     `RECONNECT_REQUIRED`/`ERROR` states in `GET /api/v1/system/info`'s
     `integrations` section immediately after any restore and treat that as
     normal, not a new bug.

## Installation-identity safety gate for restore-adjacent tooling

Any script that reads a backup/dump file and writes it into a database
(as opposed to Railway's own dashboard-driven restore) must call
`lib/installationIdentity.js#requireInstallationConfirmation(argv, {
installationId, companyName })` against the **target** database before
writing, requiring `--confirm-installation=<id-or-name>` to match. This
repo does not yet ship such a script (no automated dump-and-restore CLI
exists — Railway's dashboard restore is the only mechanism actually used
today); if one is built, wiring this gate in is a hard requirement, not an
optional hardening step, per the productization "safety gate for
destructive tooling" rule.

## Never restore EC's backup into another installation's database

EC's backups contain EC's real customer/lead/project data. No new company
installation may ever be seeded from an EC backup, in whole or in part —
this is an absolute rule (see the productization request's "do not copy EC
customer/lead/project data into another company's database"). A fresh
installation is always created via `scripts/install/bootstrap.js` against
an empty database (see `docs/INSTALL_NEW_COMPANY.md`), never by restoring
or cloning EC's data and then attempting to "clean it out" afterward.

## What is NOT covered / not yet verified

- **No isolated restore drill has been performed against a disposable
  Railway environment** — this pass (like EC's own `docs/
  DISASTER_RECOVERY.md`) documents the procedure but has not executed a
  real Railway restore, since doing so requires Railway API/dashboard
  access this sandboxed session does not have. The *database-shape* half of
  restore safety (an old schema upgrading forward cleanly) is what
  `test/integration/productization.int.test.js`'s EC-shaped-upgrade test
  actually proves, against a disposable local Postgres — that is real,
  automated, and passing; a live Railway restore-and-migrate drill remains
  an open, live-environment verification step.
- **Point-in-time recovery** is not available on Railway's standard backup
  tier (matches `docs/DISASTER_RECOVERY.md`'s existing EC finding — not a
  productization-specific gap).
- **Secrets backup/versioning** — see "What gets backed up" above; this is
  a real, tracked gap, not solved by this pass.
