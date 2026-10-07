# Product Architecture

This describes the CRM as a **reusable product**, independent of any one
customer. For EC Construction Group's specific production facts (Railway
project IDs, verified service names, EC's own operational history), see
`docs/PRODUCTION_ARCHITECTURE.md` — that file documents installation #1's
live facts, not the product. Historical Base44→Railway migration notes live
in `docs/MIGRATION.md`-equivalent files and are never part of this document
or of a new company's onboarding.

## Model: productized single-tenant-per-deployment

**This is Phase 1 of productization. It is deliberately NOT shared-database
multi-tenancy.**

```
                    ┌─────────────────────────────┐
                    │   ONE canonical codebase     │
                    │   (this GitHub repository)   │
                    └──────────────┬──────────────┘
                                   │  deployed independently, N times
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
    ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
    │  Installation #1   │ │  Installation #2   │ │  Installation #N   │
    │  EC Construction   │ │  (a new company)   │ │  (a new company)   │
    │  Group             │ │                     │ │                     │
    │                     │ │                     │ │                     │
    │  Railway project    │ │  Railway project    │ │  Railway project    │
    │  own Postgres DB    │ │  own Postgres DB    │ │  own Postgres DB    │
    │  own domain          │ │  own domain          │ │  own domain          │
    │  own secrets/OAuth   │ │  own secrets/OAuth   │ │  own secrets/OAuth   │
    └───────────────────┘ └───────────────────┘ └───────────────────┘
```

Each installation is a complete, independent deployment of the same
code: its own Railway project (or equivalent), its own PostgreSQL database,
its own domain/subdomain, its own secrets and OAuth app registrations. No
installation's database, secrets, or OAuth tokens are ever shared with
another. There is no cross-installation query path, no shared JWT signing
key, no shared encryption key — isolation is structural (separate
databases, separate processes), not a filter clause in shared tables.

**Why not shared-database multi-tenancy yet:** the schema has zero
tenant-scoping columns today, and several routes have documented
authorization gaps (see CLAUDE.md's "Ownership/authorization" section) that
would become cross-company data leakage risks under a shared-DB model.
Per-deployment isolation avoids that class of risk entirely while the
product matures. Migrating to shared multi-tenancy later is a deliberate,
separate future decision — not a target of this phase.

## What makes an installation "a company" instead of a source fork

A company's identity, branding, business rules, and enabled integrations
are **configuration and data**, not code:

| Layer | Where it lives | Examples |
|---|---|---|
| Product defaults | Source code (`lib/companyConfig.js#PRODUCT_DEFAULTS`) | Fallback timezone, fallback travel buffer |
| Company configuration | PostgreSQL (`company_settings` singleton) | Company name, branding, timezone, business hours, enabled modules |
| Secrets | Railway environment variables / `integration_credentials` (encrypted) | JWT secret, encryption key, OAuth client secrets, per-provider tokens |
| User-managed operational data | PostgreSQL (all other tables) | Leads, deals, appointments, owners, users |

No company-specific fact is ever a source-code constant that a new
installation would need to edit. See `docs/CONFIGURATION_REFERENCE.md` for
the exact field list and `docs/SECURITY_MODEL.md` for why secrets are kept
out of the configuration table.

## Why `company_settings` is a singleton (and that's correct here)

`company_settings` has always been an unscoped singleton — one row per
database, read via `ORDER BY created_at ASC LIMIT 1` — with no `company_id`
column. Under a shared-database multi-tenant model this would be a bug.
Under the productized single-tenant-per-deployment model, **it is exactly
the correct design**: each installation's database has exactly one company,
so a singleton row is the simplest possible representation, with no
tenant-scoping machinery to get wrong. This is why Phase 1 required no new
`companies` table — it extended the config surface that already existed
(`routes/companySettings.js`, already admin-facing and already generic)
rather than replacing it.

## Component map (per installation)

- **Backend API** (`server.js` + `routes/` + `lib/`) — Express app, one
  Postgres connection pool, stateless (any number of replicas can point at
  the same database).
- **PostgreSQL** — one database per installation. `db/migrate.js` is the
  only writer of schema; `db/migrations/*.sql` is the single source of
  truth for schema history, shared by every installation.
- **Frontend SPA** (`crm-frontend/`) — a static build, configured only via
  its own `VITE_*` build-time env vars (API base URL) — never bundles a
  company's data or secrets.
- **Reminder worker** (`reminderWorker.js`) — a separate long-running
  process/service per installation, reading the SAME database as the API.
  Never shared across installations (see `lib/monitoring/recoveryPolicy.js`
  — it deliberately never auto-restarts this process because a duplicate
  execution across installations would be able to double-send).
- **Calendar/Google Contacts outbox worker**
  (`scripts/calendarOutboxWorker.js`) — same isolation rule as the reminder
  worker.

## Installation identity

Every `company_settings` row carries a stable `installation_id` (UUID,
generated once, immutable) — see migration `2026-46-product-config.sql` and
`lib/installationIdentity.js`. This is the mechanism a maintenance/migration
script uses to confirm which company's database it is connected to before
doing anything destructive (`--confirm-installation=<id-or-name>`). See
`docs/SECURITY_MODEL.md` and `docs/BACKUP_RESTORE.md`.

## Configuration read path

Business logic that used to hardcode a company-specific value (a timezone,
a travel-buffer minute count, an email domain) should read it from
`lib/companyConfig.js#getCompanyConfig()` instead. That module is the single
read path over the `company_settings` singleton, with `PRODUCT_DEFAULTS`
(not company-specific data) as the last-resort fallback when a database
hasn't been configured yet. See `docs/CONFIGURATION_REFERENCE.md`.

## What Phase 1 does NOT include (by design)

- Shared multi-tenant database (deliberately deferred — see above).
- A full mechanical rewrite of every hardcoded EC-specific string in the
  codebase. Phase 1 built the configuration model, the bootstrap mechanism,
  and converted a small number of representative call sites end-to-end
  (proving the pattern is safe and testable) rather than touching ~40 files
  blind, untested, in one pass. See the Phase A audit table in the
  productization final report for the complete, categorized list of
  remaining call sites and their exact hardcoded values — nothing in that
  list was silently dropped; it is tracked, not forgotten.
- A dedicated frontend "System Health" page (the data is available via a
  new read-only API — see `docs/CONFIGURATION_REFERENCE.md` — a UI page is
  a fast follow, not a foundational blocker).
- Automatic Railway provisioning of a brand-new project/service via API
  (no Railway API token/CLI is available to build or test this from a
  sandboxed session — see `docs/INSTALL_NEW_COMPANY.md` for the documented
  manual/semi-automated procedure instead).
