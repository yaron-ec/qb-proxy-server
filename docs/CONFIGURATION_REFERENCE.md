# Configuration Reference

Every value a company can configure without editing source code, and where
it lives.

## `company_settings` (PostgreSQL singleton — one row per installation)

Read/write via `GET`/`PUT /api/v1/company-settings` (admin-only write,
authenticated read) or directly at bootstrap via
`scripts/install/bootstrap.js`. Read in business logic via
`lib/companyConfig.js#getCompanyConfig()`.

| Field | Type | Default when unset | Notes |
|---|---|---|---|
| `company_name` | text | — (required at creation) | Display name |
| `legal_name` | text | null | Legal entity name, for documents/invoices that need it |
| `dba` | text | null | "Doing business as", if different from `legal_name` |
| `company_email` | text | null | Also used to derive a default rep-email domain (`lib/companyConfig.js#getCompanyEmailDomain`) |
| `company_phone` | text | null | |
| `company_address`/`company_city`/`company_state`/`company_zip` | text | null | |
| `company_website` | text | null | |
| `company_logo_url` | text | null | |
| `favicon_url` | text | null | *(added 2026-44; not yet wired into `index.html` generation — see Phase A audit)* |
| `brand_primary_color` | text | null | *(added 2026-44; not yet wired into frontend theming — see Phase A audit)* |
| `admin_name`/`admin_email` | text | null | Primary admin contact, shown in CMS and used as one of the CRM-activity-notification recipients |
| `company_region` | text | null | Display-only label (e.g. "SoCal", "NorCal") — never a tenancy/routing concept |
| `timezone` | text | `America/Los_Angeles` | Read via `getCompanyConfig().timezone` / `getTimezone()`. **Not yet wired into `lib/booking/*`'s hardcoded timezone constants — see Phase A audit; the default matches those constants exactly so existing behavior is unaffected until that wiring is done.** |
| `locale` | text | `en-US` | Reserved for future date/number formatting; not yet read anywhere |
| `business_hours` | jsonb | null | Reserved shape (e.g. `{"mon": "9-5", ...}`); not yet read by availability logic |
| `appointment_travel_buffer_minutes` | integer | `60` | Matches `lib/booking/bookingService.js`'s current hardcoded Meeting travel buffer. **Not yet read from config by that file — see Phase A audit.** |
| `enabled_modules` | jsonb | every key `false` (a fresh install) / every key `true` (an upgraded EC-shaped row — see `docs/UPGRADE_RUNBOOK.md`) | See "Module keys" below |
| `installation_id` | uuid | generated on first insert | Immutable. See `docs/SECURITY_MODEL.md` |
| `crm_activity_notifications_enabled` | boolean | `false` | Existing field, unchanged |

### Module keys (`enabled_modules`)

`quickbooks`, `gmail`, `google_calendar`, `google_contacts`, `signnow`,
`handoff`, `meta`, `sms`, `website_intake`. See `docs/INTEGRATIONS_SETUP.md`
for what each gates. **Note (Phase A audit finding): these flags are
readable via `lib/companyConfig.js#isModuleEnabled()` today, but no route
or worker yet checks them before running its integration logic — see
"Deferred work" below.**

## Environment variables (Railway secrets — never in `company_settings`, never in git)

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | Always | Postgres connection string |
| `RAILWAY_JWT_SECRET` | Always | Signs session/access JWTs — must be unique per installation |
| `ENCRYPTION_KEY` | Always | Encrypts `integration_credentials.encrypted_payload` — must be unique per installation |
| `PROXY_SECRET` | Legacy QB passthrough only | |
| `CORS_ALLOWED_ORIGINS` | Recommended | Comma-separated list of frontend origins allowed to call this API. Unset = reflect any origin (historical default — see `docs/SECURITY_MODEL.md`) |
| `QB_CLIENT_ID`/`QB_CLIENT_SECRET`/`QB_REDIRECT_URI` | Only if QuickBooks is used | |
| `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` | Only if Gmail is used | |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_KEY` | Only if Calendar/Contacts is used | |
| `SIGNNOW_CLIENT_ID`/`SIGNNOW_CLIENT_SECRET` (or API key) | Only if SignNow is used | |
| `HANDOFF_API_KEY` | Only if Handoff is used | |
| `META_APP_SECRET` | Only if Meta Lead Ads is used | |
| `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` | Only if SMS is used | |
| `WEBSITE_LEAD_WEBHOOK_SECRET` | Only if website lead intake is used | |
| `CRM_PUBLIC_URL` | Recommended | This installation's frontend URL — used in outbound email/reminder links |

`scripts/install/bootstrap.js`'s report tells you exactly which of the
optional integration variables are present/missing for this installation.

## Per-provider credentials (PostgreSQL, encrypted — `integration_credentials`)

OAuth tokens and connected-account state (QuickBooks realm, Gmail mailbox,
SignNow account, etc.) live here, keyed by `(provider, credential_type,
environment, account_identifier)`, encrypted with `ENCRYPTION_KEY`. This
table was already generic/per-installation before productization — no
schema change was needed. See `docs/INTEGRATIONS_SETUP.md`.

## Deferred work (tracked, not forgotten)

The fields marked "not yet wired" above are genuinely configurable (stored,
readable, round-trip through the admin API) but the specific hardcoded
constants they are meant to replace have not all been mechanically
converted yet — see the Phase A audit table in the productization final
report for the complete file list, one file at a time, with the exact
string/value in each. Converting them is intentionally incremental:
`lib/repDirectory.js`'s office-email domain was converted and tested as the
proof of pattern (`getRepContactAsync`); the timezone/buffer/module-gating
conversions in `lib/booking/*` and the various integration routes are the
next, larger batch, and were not attempted blind/untested in this pass —
see `docs/PRODUCT_ARCHITECTURE.md`'s "What Phase 1 does NOT include."
