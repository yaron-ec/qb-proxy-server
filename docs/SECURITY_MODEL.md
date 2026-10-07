# Security Model (Productization — Phase F)

This document covers the cross-installation isolation model introduced by
productization. For EC's own pre-existing operational security notes, see
`docs/PRODUCTION_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, and
`docs/DISASTER_RECOVERY.md` — those remain EC-specific history, not part of
the product's general security contract described here.

## Isolation model: separate deployment, not shared database

Each installation (EC included) is a fully separate Railway
project/environment: its own Postgres database, its own set of secrets, its
own domain. There is no code path today that can read across two
installations' databases, because there is no code path that connects to
more than one `DATABASE_URL` at a time — every query in `db/`, `lib/`, and
`routes/` uses the single pool from `db/client.js`, which is configured from
this process's own `DATABASE_URL`. An external customer's installation is
architecturally incapable of seeing another installation's data, not
merely policy-restricted from it. This is the deliberate reason Phase 1
rejected shared-database multi-tenancy (see `docs/PRODUCT_ARCHITECTURE.md`):
the codebase's existing, known authorization gaps (see CLAUDE.md's
"Ownership/authorization" note — several routes have no ownership check
beyond `requireAuth`) would become cross-company data leakage risks under a
shared-DB model. Per-deployment isolation avoids that class of risk
entirely, independent of whether those gaps are ever fixed.

## Secrets that must be unique per installation

| Secret | Why it must never be shared across installations |
|---|---|
| `RAILWAY_JWT_SECRET` | Signs access/refresh tokens. A shared secret would let a token minted by one installation's login flow be accepted by another's `requireAuth` — a full cross-installation authentication bypass. |
| `ENCRYPTION_KEY` | Encrypts `integration_credentials.encrypted_payload` (AES-256-CBC, scrypt-derived key — `lib/integrationCredentialStore.js`). A shared key would let anyone with read access to one installation's Postgres dump decrypt another's OAuth tokens if they ever obtained that installation's row (they still couldn't reach it over the network — see isolation model above — but this removes a defense-in-depth layer for no reason). |
| `WEBSITE_LEAD_WEBHOOK_SECRET`, `META_APP_SECRET`, `HANDOFF_API_KEY`, `QB_CLIENT_ID`/`QB_CLIENT_SECRET`, `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_*`, `SIGNNOW_*`, `TWILIO_*` | Each is a distinct third-party app registration/credential. Reusing EC's own registration for another installation would mix that installation's traffic/webhooks with EC's account and violate the "do not expose or copy EC secrets" rule. |

`scripts/install/bootstrap.js`'s `validateRequiredEnv()` fails closed
(non-zero exit, no partial install) if `DATABASE_URL`, `RAILWAY_JWT_SECRET`,
or `ENCRYPTION_KEY` is missing — a new installation cannot come up without
its own copies of the always-required secrets. There is no code-level way
to force-generate these; `docs/INSTALL_NEW_COMPANY.md` instructs generating
each with `openssl rand -hex 32` and explicitly says never to copy an EC
value.

## Least-privilege roles

`users.role` (`db/migrations/2026-07-email-service.sql`) is a fixed enum:
`admin`, `manager`, `sales_rep`, `office`, `user`. `lib/rbac.js#requireRole`
enforces this server-side on every route that calls it — role is read from
the verified JWT (`req.user.role`), never trusted from a request body or
query param. `routes/systemInfo.js` (Phase J) is `admin`-only because it
reveals which integrations are/aren't wired for this installation, which is
operationally sensitive even though it never returns a secret value.

**Known, tracked gap (not introduced by productization — see CLAUDE.md):**
several routes (`tasks.js`, `activities.js`, `invoices.js`, all four deal
sub-resource routers, `dealFinancials.js`) call `requireAuth` but no
ownership-scoping check, so a `sales_rep` role can act on records outside
whatever their UI shows them. This is a within-installation authorization
gap, unrelated to cross-installation isolation (which does not depend on
these checks — see isolation model above) — tracked as future hardening,
not blocking productization.

## First-admin bootstrap safety

`scripts/install/bootstrap.js#ensureFirstAdmin` is check-then-insert: it
queries for an existing user with the configured admin email before ever
inserting, so re-running bootstrap (e.g. on every deploy, as
`docs/INSTALL_NEW_COMPANY.md` suggests) never creates a duplicate admin or
resets an existing admin's password. The admin password from
`company.json` is hashed (`lib/authService.js#createUser` → `hashPassword`,
scrypt) before it ever reaches the database — `company.json` itself is
documented as "keep out of git" specifically because it transiently holds
the plaintext password until bootstrap consumes it once.

## Destructive-tooling installation-identity gate

`lib/installationIdentity.js#requireInstallationConfirmation(argv, opts)`
throws unless the caller passes `--confirm-installation=<id-or-name>`
matching this database's own `company_settings.installation_id` or
`company_name` (case-insensitive name match, or exact UUID match). This
generalizes the `--confirm-host` pattern already used by
`scripts/auditAppointmentFollowUp.js`. **Any new maintenance/migration
script that can mutate or delete data across more than a handful of rows
should call this before doing so** — it is the mechanism that prevents a
script written against one installation's expected state from being run
unmodified (e.g. copy-pasted, or run with a stale shell `DATABASE_URL`)
against a different installation and silently doing the wrong thing. It is
a confirmation gate, not an authentication mechanism — it protects against
mistakes (wrong terminal, wrong `.env` sourced), not a malicious operator
who already has `DATABASE_URL` access.

## Backup/restore cannot cross installations by accident

See `docs/BACKUP_RESTORE.md`'s restore procedure — it requires confirming
the target installation's identity before a restore is considered
complete, for the same reason as the destructive-tooling gate above: a
restore run against the wrong Railway Postgres instance (e.g. a stale
target selected in a dashboard) is a data-loss mistake this check catches.

## CORS

`server.js`'s CORS middleware defaults to reflecting any origin
(`origin: true`) when `CORS_ALLOWED_ORIGINS` is unset — this is EC's
current, unchanged, verified-working production behavior, preserved
exactly for backward compatibility (see CLAUDE.md verification
requirements). **Recommendation for any new installation:** set
`CORS_ALLOWED_ORIGINS` to that installation's own frontend origin(s) from
day one, since a new installation has no existing behavior to preserve.
This is documented in `docs/CONFIGURATION_REFERENCE.md`.

## What this model does NOT cover

- **Within-installation authorization gaps** — see "Least-privilege roles"
  above. These are real, tracked, and independent of productization.
- **A compromised Railway account** — anyone with access to an
  installation's Railway project can read that installation's env vars and
  connect to its database directly. Standard Railway account security
  (2FA, limited team member access) is the control here, outside this
  codebase's scope.
- **Encryption at rest for the database itself** — this relies on Railway's
  underlying Postgres storage; `integration_credentials.encrypted_payload`
  is application-layer encryption on top of that, for the specific case of
  OAuth tokens/API keys.
- **Rate limiting / brute-force protection on login** — not audited as part
  of this pass; out of scope for the isolation model specifically.
