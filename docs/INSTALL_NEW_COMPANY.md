# Installing a New Company

This is the real, tested workflow for installing company #2 (or #3, #4,
...) of this CRM product using the **Company Provisioning System**
(`scripts/install/provisionCompany.js`,
`scripts/install/companyConfigContract.js`,
`scripts/install/railwayPlan.js`). It supersedes the older, bootstrap.js-only
procedure in `docs/NEW_COMPANY_INSTALL.md` (kept as a short pointer to this
file for existing links).

It assumes no knowledge of EC Construction Group or its migration
history — everything EC-specific lives in `docs/PRODUCTION_ARCHITECTURE.md`
and is irrelevant here. Read `docs/PRODUCT_ARCHITECTURE.md` first if you
haven't — this document assumes the productized single-tenant-per-deployment
model it describes: **one canonical codebase, one deployment per company,
zero source-code edits to onboard a new one.**

This exact workflow was proven end-to-end against a disposable database for
a fictional company ("Driftwood Builders Co.") — see
`test/integration/company3ProvisioningProof.int.test.js` — including
running the provisioner twice to prove it never duplicates data.

## What's automated vs. what's manual (read this first)

| Step | Automated? |
|---|---|
| Validating your config before anything destructive happens | **Fully automated** — `provisionCompany.js --validate-only` |
| Database migrations, company settings, first admin, dropdown lists, owner starting location | **Fully automated** — one command |
| Figuring out which Railway services you need and why | **Fully automated** — generates `RAILWAY_DEPLOYMENT_PLAN.md` |
| Computing the exact OAuth/webhook callback URLs each integration needs | **Fully automated** — generates `ONBOARDING_CHECKLIST.md` |
| Creating the actual Railway project/services/database | **Manual** — Railway has no safe, documented way to script this from this repository without your own account token; see `scripts/install/railwayPlan.js`'s header comment |
| Setting secrets in Railway's environment variables UI | **Manual** — generated as a reviewable manifest, never auto-applied |
| DNS records for a custom domain | **Manual** — instructions generated, you create the record with your own registrar |
| OAuth app registration / consent (Google, QuickBooks, SignNow, Meta) | **Manual** — inherently requires a human with access to that provider's console |
| Connecting each integration after first login | **Manual** — one click in the CRM's own Integrations page per module |

## Prerequisites

- A Railway account (or equivalent platform) able to host a new project.
- Node.js ≥ 18 and `psql`/network access to the database you're
  provisioning against, from wherever you run the provisioner (your laptop,
  a CI job, or a Railway one-off shell).
- Nothing else — no Railway API token, no pre-existing infrastructure.
  You can validate your config entirely offline before provisioning
  anything.

## Step 1 — Prepare your company configuration

Create a `company.json` file (**keep it out of git** — it holds
`admin_password`; the repo's `.gitignore` already excludes
`*.company.json`). The authoritative field list, with types and validation
rules, is `scripts/install/companyConfigContract.js#FIELD_SPECS` — this is
a representative example, not the complete contract:

```json
{
  "company_name": "Acme Remodeling",
  "legal_name": "Acme Remodeling LLC",
  "company_slug": "acme-remodeling",
  "currency": "USD",
  "company_email": "hello@acme.example",
  "company_phone": "(555) 555-0100",
  "company_website": "https://acme.example",
  "timezone": "America/New_York",
  "appointment_travel_buffer_minutes": 60,
  "enabled_modules": { "quickbooks": false, "gmail": true, "google_calendar": true, "google_contacts": false, "signnow": false, "handoff": false, "meta": false, "sms": false, "website_intake": true },
  "admin_name": "Jordan Admin",
  "admin_email": "jordan@acme.example",
  "admin_password": "a real, unique, strong password — 12+ characters",
  "default_owner_name": "Jordan Admin",
  "default_owner_starting_location": "123 Main St, Acme City, ST 00000",
  "project_types": ["Kitchen Remodel", "Bathroom Remodel", "Roofing", "Solar", "Other"],
  "lead_sources": ["Website", "Google Search", "Referral", "Social Media", "Other"],
  "statuses": ["New", "Appointment scheduled", "Sold", "Lost"],
  "contact_owners": ["Jordan Admin"],
  "frontend_url": "https://crm.acme.example",
  "backend_url": "https://acme-crm-api.up.railway.app",
  "custom_domain": "crm.acme.example"
}
```

`company_name`, `company_slug`, `admin_email`, `admin_password`,
`frontend_url`, and `backend_url` are required. Everything else is
optional — omitted fields fall back to `lib/companyConfig.js#PRODUCT_DEFAULTS`
(generic product defaults, never EC's data), or to the frontend's own
universal default lists until you save Settings for the first time.
`enabled_modules` keys you don't list default to `false` — a brand-new
install starts with every optional integration OFF.

**Validate it before doing anything else** — this step touches no database
and no network:

```bash
npm run provision-company -- --config=./company.json --validate-only
```

Fix every error it reports (missing required fields, a malformed
`company_slug`, an invalid timezone/currency code) before continuing.
Warnings (e.g. "module enabled but its env vars aren't set in this
process") are informational — they don't block provisioning, since those
secrets belong on the Railway deployment, not in your local shell.

## Step 2 — Provision the infrastructure

Railway does not offer a documented, safe way to script "create a project
with N services from a GitHub repo" without your own account token, and
actually creating billable cloud infrastructure deserves your own
in-the-moment confirmation regardless — so this part is manual. Run the
provisioner once (step 3 below) first; it writes
`RAILWAY_DEPLOYMENT_PLAN.md` telling you exactly which services THIS
company's config needs (and which it doesn't — e.g. the calendar-outbox
worker is only listed if `google_calendar`/`google_contacts` is enabled) and
the Railway setup for each.

In short:
1. Create a new Railway project. **Do not reuse or add services to EC's own
   `devoted-courtesy` project.**
2. Add a Railway-managed PostgreSQL database.
3. Add the API service (`Dockerfile`, start command
   `sh -c 'node db/migrate.js && node server.js'`) and the frontend service
   (`crm-frontend/Dockerfile`) from this same GitHub repo.
4. Add any worker services `RAILWAY_DEPLOYMENT_PLAN.md` says you need.
5. `railway.json` in this repo is **EC's own deployment template** — reuse
   its `deploy`/`watchPaths` structure, but it names EC's specific services;
   don't point a new company's project at the literal file as-is.
6. Configure per-service **watch paths** in the Railway dashboard (see
   `railway.json`'s own `watchPaths` entries per service type) — without
   them, a push to the branch redeploys every service in the project even
   when only one service's files changed.

## Step 3 — Run the provisioner

With `DATABASE_URL` pointed at this company's own, otherwise-empty
database (Railway sets this automatically once Postgres is attached, or
set it manually for a one-off provisioning run from elsewhere):

```bash
DATABASE_URL=postgres://... \
RAILWAY_JWT_SECRET=<fresh, unique, never EC's> \
ENCRYPTION_KEY=<fresh, unique, never EC's> \
npm run provision-company -- --config=./company.json --generate-secrets --out=./provisioning-output/acme
```

This single command:
1. Re-validates the full config (same check as `--validate-only`).
2. Computes the onboarding checklist and Railway deployment plan.
3. Runs the full migration chain (`db/migrate.js` — safe to re-run,
   skips already-applied migrations).
4. Creates `company_settings`, the first admin, the Lead/Deal dropdown
   lists, and (if configured) the owner's starting location for Daily
   Map/routing — each one **idempotently**: re-running this exact command
   against the same database never creates a duplicate row, never
   duplicates the admin, and never overwrites `app_lists` or
   `owner_starting_locations` once they exist.
5. Runs direct-database post-provision health checks (never trusts its own
   subprocess exit code alone) — `company_settings` row exists and matches,
   the configured admin exists, migrations actually applied, enabled
   modules match what you configured.
6. Writes three files to `--out` (default
   `./provisioning-output/<company_slug>/<timestamp>/`, **gitignored, never
   commit these**):
   - `env.manifest.txt` — every environment variable this deployment needs,
     with `--generate-secrets` filling in freshly-generated
     `RAILWAY_JWT_SECRET`/`ENCRYPTION_KEY` values (only when they aren't
     already set in your current environment — never rotates an existing
     one) and a placeholder for every secret that needs a human to supply
     it.
   - `ONBOARDING_CHECKLIST.md` — for each enabled module, whether it needs
     human authorization, which provider, the exact callback/webhook URL
     computed from YOUR `frontend_url`/`backend_url` (not a guess), and
     which env vars are still missing. Includes DNS instructions if you set
     `custom_domain`.
   - `RAILWAY_DEPLOYMENT_PLAN.md` — see Step 2.
7. Prints one JSON report to stdout — `ok: true` means success;
   `config.admin_password` and every secret field are always `<redacted>`,
   never the real value, so this report is safe to paste into a ticket or
   log.

**Re-run this exact command any time** — to add a worker service later, to
re-check health, or as part of every future deploy. It will never corrupt
existing data or reset real customer data; see "Idempotency" in each
artifact's own header comment for the specifics.

## Step 4 — Set secrets on the Railway deployment

Open `env.manifest.txt` and, for each variable:
- `DATABASE_URL` — already set automatically by Railway.
- `RAILWAY_JWT_SECRET` / `ENCRYPTION_KEY` — paste the generated values (or
  your own `openssl rand -hex 32` output) into the Railway service's
  environment variables. **Never reuse EC's values** — see
  `docs/SECURITY_MODEL.md`.
- Per-module secrets (`QB_CLIENT_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY`, etc.) —
  only needed for modules you enabled; leave the rest blank. A disabled
  module needs no credentials at all and runs no background integration
  work (every optional module is gated by
  `lib/moduleGate.js`/`companyConfig.isModuleEnabled()` — see
  `docs/CONFIGURATION_REFERENCE.md`'s "Module keys").

Never commit `env.manifest.txt` or any file containing a real secret value.

## Step 5 — Domain/DNS and OAuth/integration authorization

Open `ONBOARDING_CHECKLIST.md` and work through it top to bottom:
- **Custom domain** (if configured): add it as a Custom Domain on the
  frontend Railway service, then create the DNS record it shows you with
  your own registrar. Allow up to 48 hours for propagation.
- **Each enabled module**: follow its own provider-specific instructions
  (create an OAuth app / service account / API key at the named provider),
  using the exact callback/webhook URL the checklist computed for you —
  never derive this by hand.
- Modules needing no human step at all (a plain API key, like Handoff) are
  marked as such — just set the one env var.

## Step 6 — Deploy and verify

Deploy the Railway services (the API service's own startup runs
`db/migrate.js` again automatically — a safe no-op if you already ran the
provisioner). Then:

```sql
-- Against the new company's own database:
SELECT count(*) FROM leads;    -- expect 0
SELECT count(*) FROM owners;   -- expect 0 (or 1, if you pre-seeded an owner)
SELECT count(*) FROM users;    -- expect exactly 1 (the admin the provisioner created)
SELECT company_name, installation_id, company_slug FROM company_settings;  -- the NEW company's own values, a fresh UUID
```

Sign in at the frontend URL with the admin email/password from
`company.json`. From there:
- **Company Settings** (admin UI) — refine branding, business hours,
  enabled modules further; every field is editable without a redeploy.
- **Add additional users/roles** (`routes/users.js`'s existing admin-only
  user management — unchanged, reused as-is).
- **Connect each integration** you enabled — one click per module on the
  Integrations page, using the OAuth app/credentials you set up in Step 5.
  The CRM's core (leads, deals, appointments, follow-ups, Daily Map) works
  fully with zero integrations connected.

## Rollback / failure handling

- **Provisioner reports `ok: false`**: read `error` and the relevant
  sub-report (`validation.errors`, `bootstrap.steps`, `health_checks`) — it
  never partially commits a broken state silently; re-run after fixing the
  reported problem. A failed run before any DB write (validation, missing
  `DATABASE_URL`) touches nothing at all.
- **Wrong database targeted** (e.g. a stale `DATABASE_URL` accidentally
  pointed at a different installation, including EC's own): the provisioner
  refuses before writing anything, via
  `lib/installationIdentity.js#requireInstallationConfirmation` matching
  this config's own `company_name` against whatever the target database
  already has — a mismatch is a hard, safe failure, not a silent
  overwrite.
- **Need to start over on a genuinely fresh attempt**: drop and recreate
  the database, then re-run the provisioner from Step 3 — it detects the
  empty database and creates everything fresh again.
- **Database-level restore**: see `docs/BACKUP_RESTORE.md` for the general,
  per-installation backup/restore procedure (Railway-managed Postgres
  backups, what is and isn't currently backed up, the known gap around
  secret-value recovery).

## Update/upgrade procedure — how future canonical releases propagate

Every installation runs the same canonical codebase from its own Railway
deployment, pointed at its own branch/commit. See `docs/UPGRADE_RUNBOOK.md`
for the full versioning and migration-compatibility model; in short:
- A push to the branch a company's Railway services track triggers their
  own redeploy (per their own configured watch paths from Step 2) — there
  is no separate "propagate to customers" step; it's the same deploy
  pipeline as any other code change.
- `db/migrate.js` runs automatically on every API service startup and is
  always a safe no-op against an up-to-date database — migrations in this
  repo are additive-only by convention (see `docs/UPGRADE_RUNBOOK.md`),
  so upgrading never requires a company to change its own configuration
  unless a specific release note says so.
- A schema or `enabled_modules`-shape change that genuinely needs a
  company to act (a new required config field, a new module) will be
  called out in that release's own notes — the contract version
  (`companyConfigContract.js#CONTRACT_VERSION`) only bumps on such a
  breaking change, never on a purely additive one.

## Backup expectations

See `docs/BACKUP_RESTORE.md` for the full procedure. In short: Railway's
own managed Postgres backups cover all of an installation's data; secrets
(Railway environment variables) are not versioned by Railway and have no
code-level backup — keep your own secure record of each installation's
secret values (a password manager, not a text file) outside git.

## What a fresh installation will NEVER have

- EC's leads, deals, appointments, owners, or any customer data.
- EC's OAuth tokens, API keys, or Railway secrets — every integration is
  connected fresh, per installation, through its own OAuth flow or its own
  credentials.
- Yaron, Michelle, Yair, or any other EC individual as a user, default
  owner, or notification recipient — a fresh installation's only user is
  the admin the provisioner created.
- EC's Woodland Hills address, branding, project types, or lead sources —
  every one of these comes from your own `company.json`, never a silent
  EC-shaped default (see `test/integration/company3ProvisioningProof.int.test.js`'s
  flow 18 for the automated proof of this).
