# Installing a New Company

This is the procedure for installation #2 (or #3, #4, ...) of this CRM
product. It assumes no knowledge of EC Construction Group or its migration
history — everything EC-specific lives in `docs/PRODUCTION_ARCHITECTURE.md`
and is irrelevant here.

Read `docs/PRODUCT_ARCHITECTURE.md` first if you haven't — this document
assumes the productized single-tenant-per-deployment model it describes.

## 1. Provision infrastructure

1. Create a new Railway project (or your platform of choice) for this
   company. Do not reuse EC's project.
2. Add a PostgreSQL database to it.
3. Add two services from this same GitHub repository:
   - the API (`Dockerfile`, start command `sh -c 'node db/migrate.js && node server.js'`)
   - the reminder worker (`Dockerfile.worker`), if this company will use
     reminders (it can be added later — see `docs/CONFIGURATION_REFERENCE.md`
     module flags).
4. `railway.json` in this repo is EC's own deployment template (its service
   `name`/project fields are EC-specific labels — the `deploy`/`watchPaths`
   structure is generic and reusable). Copy it for the new company and
   rename the identifying fields; do not point a new company's Railway
   project at the literal file as-is.

## 2. Required secrets (set as environment variables on the API service)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Set automatically by Railway when Postgres is attached |
| `RAILWAY_JWT_SECRET` | Generate a fresh, unique random string — **never reuse EC's** |
| `ENCRYPTION_KEY` | Generate a fresh, unique key — **never reuse EC's** (encrypts `integration_credentials`) |
| `PROXY_SECRET` | If any legacy QuickBooks-proxy passthrough is used |

Generate secrets with e.g. `openssl rand -hex 32`. Never copy a secret value
from EC's Railway environment into a new company's environment — see
`docs/SECURITY_MODEL.md`.

## 3. Run the bootstrap

From a machine/CI job with `DATABASE_URL` (and the two required secrets
above) set in its environment, and pointed at the NEW company's database:

```bash
node scripts/install/bootstrap.js --config=./company.json
```

`company.json` (keep this file out of git — it may contain the first
admin's password):

```json
{
  "company_name": "Acme Remodeling",
  "legal_name": "Acme Remodeling LLC",
  "company_email": "hello@acme.example",
  "company_phone": "(555) 555-0100",
  "company_website": "https://acme.example",
  "timezone": "America/New_York",
  "appointment_travel_buffer_minutes": 60,
  "enabled_modules": { "quickbooks": false, "gmail": true, "google_calendar": true, "sms": true, "website_intake": true },
  "admin_name": "Jordan Admin",
  "admin_email": "jordan@acme.example",
  "admin_password": "a real, unique, strong password"
}
```

Every field is optional except `company_name` on the very first run. Fields
you omit fall back to `lib/companyConfig.js#PRODUCT_DEFAULTS` (generic
defaults, never EC's data). `enabled_modules` keys not listed default to
`false` — a brand-new install starts with every optional integration OFF
unless you explicitly turn it on.

Bootstrap is **idempotent** — running it again (e.g. as part of every
deploy) never creates a duplicate company row or a duplicate admin. It
prints a JSON report to stdout; a non-zero exit code means something failed
(missing required env var, a database it can't reach). All human-readable
progress (including the full migration log) goes to stderr, so
`bootstrap.js ... > report.json` captures exactly one clean JSON document.

## 4. Verify the installation

The bootstrap report's `steps.integrations` section lists, per optional
integration, whether its required environment variables are present. This
is a presence check only — it does not attempt to contact QuickBooks,
Google, etc. Connect each integration you intend to use through its own
admin-facing setup flow after first login (see
`docs/INTEGRATIONS_SETUP.md`).

Confirm no EC data exists in the new database:

```sql
SELECT count(*) FROM leads;    -- expect 0
SELECT count(*) FROM owners;   -- expect 0
SELECT count(*) FROM users;    -- expect exactly 1 (the admin bootstrap created)
SELECT company_name, installation_id FROM company_settings;  -- the NEW company's name, a fresh UUID
```

## 5. First login

Sign in at the new deployment's frontend URL with the admin email/password
from `company.json`. From there:

- Company Settings (admin UI) — refine branding, timezone, business hours,
  enabled modules further; every field is editable without a redeploy.
- Add additional users/roles (`routes/users.js`'s existing
  admin-only user management — unchanged, reused as-is).
- Connect the integrations this company actually uses — see
  `docs/INTEGRATIONS_SETUP.md`. Every integration is optional; the CRM's
  core (leads, deals, appointments, follow-ups) works with zero
  integrations connected.

## 6. What this installation will NEVER have

- EC's leads, deals, appointments, owners, or any customer data.
- EC's OAuth tokens or API keys — every integration is connected fresh,
  per installation, through its own OAuth flow.
- Yaron, Michelle, or Yair as any kind of user — a fresh installation's
  only user is the admin created in step 3.
