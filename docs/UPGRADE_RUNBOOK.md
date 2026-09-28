# Upgrade Runbook

## Versioning

The product version is `package.json#version` (currently `1.0.0` — this
productization pass did not bump it; see "Recommendation" below). There is
no separate per-installation version — every installation runs whatever
commit its Railway service is deployed from. `build-info.json`-style
patterns already exist in the sibling website product (`ec-construction-group-website`)
for exactly this purpose (identifying which commit a live deployment is
serving); the equivalent for this backend is `git rev-parse HEAD` at
deploy time, exposed the same way — see "Deferred: version visibility"
below.

**Recommendation (not yet applied):** adopt semantic versioning going
forward — `MAJOR.MINOR.PATCH` — and bump on every release that touches
`db/migrations/` or any installation-facing contract (bootstrap config
shape, `enabled_modules` keys). A schema-affecting change should always be
a MINOR or MAJOR bump so an operator upgrading many installations knows
which ones need `node db/migrate.js` re-run (all of them, since migrations
are additive-only and safe to re-run — see below) versus which ones need a
config change too.

## Migration compatibility

- `db/migrate.js` is the single migration runner, shared by every
  installation. It tracks applied migrations in `schema_migrations` and
  skips already-applied files — running it against an up-to-date database
  is always a safe no-op.
- Every migration in this repo, including `2026-46-product-config.sql`, is
  additive: new tables/columns only, with defaults chosen to preserve
  existing behavior (verified for `2026-44` — see
  `test/integration/productization.int.test.js`'s upgrade test). This
  convention should continue: a productization-era migration must never
  `DROP`, `ALTER ... TYPE`, or rename a column that existing code reads,
  without a documented, tested backward-compatibility plan.
- `db/schema.sql` is a **partial legacy snapshot only** (see CLAUDE.md) —
  never treat it as canonical; `db/migrations/*.sql` + `schema_migrations`
  is the only source of truth for what schema a given installation has.

## Upgrade procedure (any installation, including EC)

1. **Pre-deploy backup** — see `docs/BACKUP_RESTORE.md`. Never skip this for
   a release that adds a migration.
2. Deploy the new code (Railway's normal deploy pipeline). The Dockerfile
   chain (`node db/migrate.js && node server.js`) means migrations run
   automatically before the server starts — a failing migration blocks
   startup rather than running the app against a half-upgraded schema
   (existing behavior, unchanged).
3. **Health gate**: confirm `/health` returns 200 and the migration log
   shows the expected new migration(s) applied (`N applied, M skipped`).
4. **Post-deploy verification**: run this installation's own smoke checks
   (for EC: the existing `npm run test:integration` pattern against a
   disposable copy, plus the manual acceptance steps already documented in
   `docs/PRODUCTION_ACCEPTANCE_REPORT.md` for EC specifically — a new
   installation should have its own lightweight equivalent, not EC's).

## Rollback procedure

- **Code rollback**: redeploy the previous Railway deployment/commit.
  Since every migration is additive, a previous version's code can run
  against a schema that has EXTRA columns it doesn't know about — those
  columns are simply unused by the older code, not a correctness problem.
- **Schema rollback**: `db/rollback/*.sql` exists for migrations that
  provide one (check before assuming one exists for a specific migration —
  not every migration in this repo has a paired rollback file today; this
  is a pre-existing gap, not introduced by productization).
  `2026-46-product-config.sql` is purely additive (new nullable/defaulted
  columns) — rolling back the CODE is sufficient; the new columns being
  present but unread by older code is harmless, so no rollback SQL is
  required for this specific migration.
- **Never** roll back by restoring a backup taken after the problematic
  deploy — that discards real data written since. Restore-based rollback is
  a last resort; see `docs/BACKUP_RESTORE.md`'s restore procedure and its
  installation-identity safety gate.

## Version visibility

`GET /api/v1/system/info` (admin-only) answers "which version/schema state
is this installation running" via one authenticated request: product
version (`package.json#version`), migration count and last-applied
timestamp (`schema_migrations`), this installation's identity
(`lib/installationIdentity.js#identify()` — never another installation's),
and per-integration state (env-var presence, layered with
`integration_credentials`-derived CONNECTED/RECONNECT_REQUIRED/ERROR state
for the three integrations that persist a credential row — QuickBooks,
Gmail, SignNow's password-grant fallback; every other module is
env-presence-only, since it never writes a row — see
`docs/INTEGRATIONS_SETUP.md`). No secret value is ever included. See
`routes/systemInfo.js` and `test/systemInfo.test.js`.

**Not yet implemented:** a deployed-commit identifier (`git rev-parse
HEAD` at build/deploy time, e.g. a `build-info.json` written by the
Dockerfile, matching the pattern already used by the sibling
`ec-construction-group-website` product) is not included in this
endpoint's response — only the `package.json` semantic version. Adding it
is a small, low-risk follow-up.
