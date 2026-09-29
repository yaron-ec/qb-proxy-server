# Integration Setup

Every integration below is optional for core CRM operation (leads, deals,
appointments, follow-ups, tasks work with zero integrations connected).
Each is independently configurable per installation — one company's
credentials are never usable by another (separate databases,
`integration_credentials` rows, and Railway environments).

## State model

| State | Meaning |
|---|---|
| `NOT_CONFIGURED` | No credentials/env vars present for this provider |
| `CONFIGURED` | Env vars/app registration present, but no successful OAuth connection yet (or no `integration_credentials` row) |
| `CONNECTED` | A valid, non-expired credential exists and was used successfully recently |
| `RECONNECT_REQUIRED` | A credential exists but is expired/revoked (`integration_credentials.status`, `last_error_message`) |
| `ERROR` | The last attempted use failed for a reason other than expiry (`last_error_at`/`last_error_message` recent) |

This maps directly onto the existing `integration_credentials` table
(`status`, `expires_at`, `last_error_at`, `last_error_message`,
`refreshed_at`, `last_used_at` — all already present, already generic
per-provider/per-installation columns; no schema change was needed for this
model). `scripts/install/bootstrap.js`'s report surfaces the env-var
presence half of this (`NOT_CONFIGURED` vs "present"); `GET
/api/v1/system/info` (admin-only) layers the `integration_credentials`
state on top for the modules that actually persist a credential row.

**Important: only three modules ever write an `integration_credentials`
row today** — verified against the actual writers, not inferred from
naming convention:

| Module | `provider` | `credential_type` |
|---|---|---|
| QuickBooks | `intuit` | `quickbooks` |
| Gmail | `google` | `gmail` |
| SignNow | `signnow` | `password` (OAuth2 password-grant fallback path only) |

SignNow's *primary* auth (`SIGNNOW_API_KEY`) is a stateless bearer token
with no stored credential — a SignNow that shows env-configured but no
CONNECTED/ERROR state is expected, not a bug. `google_calendar`/
`google_contacts` (service-account, domain-wide delegation),
`handoff` (`app_settings` or env var), `meta` (webhook HMAC secret only),
`sms` (Twilio, used only for internal critical alerts in
`lib/reminderAlerts.js` today, not customer-facing) and `website_intake`
(webhook shared secret) never write a row here at all — their state in
`GET /api/v1/system/info` is necessarily env-presence-only
(`NOT_CONFIGURED`/`CONFIGURED`), never `CONNECTED`/`RECONNECT_REQUIRED`/
`ERROR`. See `routes/systemInfo.js`'s `CREDENTIAL_SOURCE` map.

## QuickBooks

- OAuth2 only — no username/password is ever stored.
- Canonical, self-healing token refresh: `server.js`'s mutexed,
  PostgreSQL-backed implementation (unchanged by productization — see
  CLAUDE.md's "QuickBooks token refresh" note for the two known-duplicate,
  lower-priority refresh paths that predate this work and are out of scope
  here).
- Per-installation: `QB_CLIENT_ID`/`QB_CLIENT_SECRET`/`QB_REDIRECT_URI` are
  this installation's own Intuit app registration; the connection itself
  (realm ID, tokens) lives in `integration_credentials`, scoped to this
  database only.
- Connect via the existing OAuth flow (`GET /auth/connect` →
  `POST /auth/callback`) from the admin QuickBooks settings screen.

## Google (Calendar, Contacts, Gmail)

- Company-specific OAuth connection (Gmail) or service-account
  domain-wide-delegation (Calendar/Contacts) — no EC account is assumed
  anywhere in the connection flow.
- `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` for Gmail; a service account
  (`GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_KEY`) for
  Calendar/Contacts.
- Gmail is single-mailbox per installation today (see CLAUDE.md — "not
  genuinely multi-account"); that constraint is per-installation, not
  cross-installation, so it doesn't block multiple companies each having
  their own single connected mailbox.

## Twilio / SMS

- Company-specific `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, phone number,
  and (where applicable) A2P messaging-service configuration.
- SMS consent capture/storage (`sms_consent*` columns, disclosure
  versioning) is schema-level and already per-installation (each
  installation's own `leads` table) — no changes needed for isolation;
  compliance copy (disclosure text) is content, not infrastructure, and
  should be reviewed per company/jurisdiction before enabling this module.
- One installation's Twilio credentials are structurally unusable by
  another: they live only in that installation's Railway environment, never
  read from any shared location.

## SignNow

- Independently configurable per installation: API key (primary) or OAuth2
  password grant (fallback), stored in `integration_credentials`.

## Handoff

- Independently configurable: static API key, stored either as an env var
  or in `app_settings` — never a source-code constant.

## Meta (Facebook Lead Ads)

- Independently configurable: `META_APP_SECRET` per installation, used to
  verify webhook HMAC signatures. **Known hardening item, not new to
  productization:** this fails OPEN if unset (CLAUDE.md) — verify it is
  actually set before enabling this module for any installation, including
  EC.

## Website lead intake

- Company-specific authenticated webhook: `WEBSITE_LEAD_WEBHOOK_SECRET` per
  installation (fails closed — 503 — if unset, unlike Meta above).
- Idempotency and duplicate protection are already implemented per-database
  (`website_lead_receipts`, `Idempotency-Key` header) — no cross-installation
  concern since each installation's receiver only ever sees its own traffic.
- Lead source is configurable (mapped in the receiving route, not
  hardcoded to "Website").

## Email

- Sender/provider (currently Gmail, single mailbox — see above) and
  company branding (logo, colors, sender name) are configuration
  (`company_settings` + `lib/emailTemplates.js`'s templates, which already
  take business/branding fields as parameters rather than hardcoding them
  inline — verify this for any new template added going forward).

## A company that doesn't use an integration

Every integration above is read through `lib/companyConfig.js#isModuleEnabled()`
and/or an env-var presence check — never a required dependency for server
startup or for using the rest of the CRM. `scripts/install/bootstrap.js`
never fails because an optional integration's variables are absent; it
reports them as `NOT_CONFIGURED` and continues.

**Enforcement (Phase 2):** `lib/moduleGate.js#requireModuleEnabled(key)` is
an Express middleware that returns `404 module_disabled` — never a
missing-secret error or a fake unhealthy status — for a disabled module's
routes. Wired into:
- `routes/signnow.js` (every route except `/status`, so the admin settings
  panel can still show "disabled" rather than a broken 404)
- `routes/handoffEstimates.js`
- `routes/leadQB.js` and `routes/qbInboundSync.js` (QuickBooks) — including
  `routes/cronJobs.js#/qb-inbound-reconcile`, which calls
  `lib/qbInboundSync.js` directly rather than through its own gated router,
  and would otherwise still fire real QuickBooks API calls on a schedule for
  a company with QuickBooks disabled
- `routes/metaWebhook.js`'s lead-processing `POST` only — its `GET`
  verification handshake (`hub.challenge`) is deliberately never gated, since
  Meta's own dashboard depends on it always responding correctly

`GET /api/v1/system/info` also reports `module_enabled` and a `DISABLED`
connection state per integration regardless of any stale
`integration_credentials` row — see `docs/CONFIGURATION_REFERENCE.md`'s
"Module keys" section. Real-Postgres end-to-end proof (not just the
middleware in isolation):
`test/integration/moduleGateWiring.int.test.js`.

**Still deferred:**
- `routes/signnowWebhook.js` (SignNow's own inbound webhook, distinct from
  `routes/signnow.js`'s admin-facing routes above) does not check
  `isModuleEnabled()` yet.
- Google Calendar/Contacts sync and both background workers (reminder
  worker, calendar-outbox worker) don't check it either — deliberately not
  attempted in this pass: unlike the single-router integrations above,
  Google Calendar is embedded throughout the booking write path itself, and
  the workers are the exact processes CLAUDE.md flags as
  never-safe-to-experiment-on (a duplicate execution can
  double-send/double-process). This needs its own careful, dedicated pass —
  not a drive-by extension of the route-gating pattern.
