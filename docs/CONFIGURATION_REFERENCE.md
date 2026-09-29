# Configuration Reference

Every value a company can configure without editing source code, and where
it lives. Four distinct layers, in the order a value is resolved:

1. **Product defaults** (source code — `lib/companyConfig.js#PRODUCT_DEFAULTS`,
   `scripts/install/bootstrap.js`'s neutral fresh-install values). Never
   company-specific; the last-resort fallback before any `company_settings`
   row exists.
2. **Company configuration** (`company_settings` in PostgreSQL — this
   section). Admin-editable via `GET`/`PUT /api/v1/company-settings`, read
   everywhere else via `lib/companyConfig.js`/`lib/notificationRecipients.js`.
   One row per installation (see `docs/PRODUCT_ARCHITECTURE.md` on why a
   singleton is correct here, not shared-tenant tech debt).
3. **Secure environment/secrets** (Railway env vars + the encrypted
   `integration_credentials` table) — never in `company_settings`, never in
   git. See the two tables below.
4. **User-managed operational data** (`leads`, `deals`, `appointments`,
   `users`, `owners`, and every other table) — created/edited through the
   product's normal UI/API, not configuration in this document's sense.

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
| `favicon_url` | text | null | Loaded by `crm-frontend/src/components/Layout.jsx` with a preload-then-swap fallback model (see `docs/PRODUCT_ARCHITECTURE.md`) — never wired directly into `index.html`'s build-time `<link rel="icon">`, which stays the static default. |
| `brand_primary_color` | text | null | A hex color (e.g. `#f59e0b`) admin-settable via a color picker in Company Settings. `crm-frontend/src/lib/brandColor.js#hexToHslTriplet` converts it to the shadcn/ui `--primary` CSS variable's format; `Layout.jsx` applies it with the same never-break-on-a-bad-value discipline as the logo/favicon (an invalid/missing value simply leaves the product-default amber token in place — see `test/integration/moduleGateWiring` sibling tests and `crm-frontend/src/lib/brandColor.test.jsx`). |
| `admin_name`/`admin_email` | text | null | Primary admin contact; fallback "to" recipient for `notification_recipients` and fallback `default_owner_email`/`default_owner_name` when those aren't set explicitly. |
| `company_region` | text | null | Display-only label (e.g. "SoCal", "NorCal") — never a tenancy/routing concept |
| `timezone` | text | `America/Los_Angeles` | Read via `getCompanyConfig().timezone` / `getTimezone()`. Wired into booking-time conversion (`lib/captureValidation.js#laToUtcStart`, `lib/booking/slotBlocking.js#toUtcIso`, `routes/publicCapture.js`, `routes/metaWebhook.js`, `routes/leads.js`'s appointment booking) AND into every reminder-window/scheduling path: `lib/reminderTime.js#pacificToUtcMs`/`toLA`, `lib/reminderEngine.js`, `lib/phoneCallReminders.js`, `lib/booking/followUpReminders.js` (the Phone Call follow-up reminder's Google Calendar event), `lib/booking/phoneCallIntegrity.js` (admin diagnostic). Each resolves it once per run/request rather than per-lead. See `test/multiTimezoneBooking.test.js` and the timezone-propagation Phase 2 commit. A few internal SQL `AT TIME ZONE 'America/Los_Angeles'` literals in `routes/cronJobs.js`'s own display-only logging remain — tracked, low-priority (they affect a log line's readability, not any stored value or customer-facing behavior). |
| `locale` | text | `en-US` | Read by `lib/reminderTime.js#formatDate` (resolved once per run in `lib/reminderEngine.js`/`lib/phoneCallReminders.js`) for the date format in customer-facing reminder emails — e.g. `en-GB` → "22 July 2026" instead of "July 22, 2026". Not yet wired into every other date-display surface (most of the frontend renders dates via `crm-frontend/src/lib/formatters.js`, which itself hardcodes `en-US`) — tracked, deferred; the reminder-email path was prioritized as the highest-volume customer-facing surface. |
| `business_hours` | jsonb `{start,end}` (24h `HH:MM`) | null → the product-default 08:30–18:30 grid | Read by `lib/booking/availabilityService.js#getEffectiveSlots()`; `lib/booking/slotBlocking.js#computeSlots(start,end)` generates the grid. Falls back to the default grid on anything malformed — never throws, never silently narrows a company's real bookable hours. The frontend's appointment-time pickers (`AppointmentSlotPicker.jsx`, `AvailableTimePicker.jsx`, `CaptureSlotGrid.jsx`) read the backend's actual grid (`GET .../availability`'s new `slots` field) instead of each having its own hardcoded duplicate. See `test/businessHoursConfig.test.js`, `test/integration/appointmentBufferBoundary.int.test.js#B7`. |
| `appointment_travel_buffer_minutes` | integer | `60` | Read by `lib/booking/bookingService.js#busyWindow` (what gets stored as an appointment's `busy_range` at write time), `lib/booking/calendarOutbox.js` (the "Driving / Travel Time" event's duration), and `lib/booking/googleAvailability.js#getBufferMs` (buffering a genuine external Google event the same way, so a company's own appointments and outside events use one consistent buffer). CLAUDE.md's canonical "1h before + duration + 1h after" blocking rule is preserved exactly for the default (unconfigured) value — see `test/integration/appointmentBufferBoundary.int.test.js#B1-B6` (unchanged) and `#B7` (proves a different configured value genuinely changes the blocked window end-to-end, including a real booking at a slot the default buffer would reject). |
| `enabled_modules` | jsonb | every key `false` (a fresh install) / every key `true` (an upgraded EC-shaped row — see `docs/UPGRADE_RUNBOOK.md`) | See "Module keys" below |
| `installation_id` | uuid | generated on first insert | Immutable. See `docs/SECURITY_MODEL.md` |
| `crm_activity_notifications_enabled` | boolean | `false` | Existing field, unchanged |
| `notification_recipients` | jsonb `{to:[],cc:[]}` | EC's historical Michelle-to/Yaron-cc pair on an **upgraded** row; `{to:[admin_email],cc:[]}` on a **fresh bootstrap install** | Read via `lib/notificationRecipients.js#getRecipients()`/`getAllStaffRecipients()`. The single resolution point for every staff-facing operational email (lead/activity notifications, appointment reminders cc, phone-call staff alerts, SignNow signed-document notifications, capture new-lead alerts) — see `docs/INTEGRATIONS_SETUP.md`. |
| `email_from_name` | text | `'EC Construction CRM'` on upgrade / `'<company_name> CRM'` on fresh install | Outbound email "From" display name. |
| `default_owner_email`/`default_owner_name` | text | Yaron/`'Yaron Drilevich'` on upgrade / this installation's own admin on fresh install | Who a lead/call routes to with no explicit assigned rep (Meta leads, Google Contacts impersonation fallback). Read via `lib/notificationRecipients.js#getDefaultOwner()`. |
| `protected_admin_emails` | jsonb array | `[yaron@, michelle@]` on upgrade / `[]` on fresh install | Admin accounts `DELETE /api/v1/users/:id` refuses to remove by name, on top of the universal "never delete the last remaining admin" rule that applies regardless of this list. |

### Module keys (`enabled_modules`)

`quickbooks`, `gmail`, `google_calendar`, `google_contacts`, `signnow`,
`handoff`, `meta`, `sms`, `website_intake`. See `docs/INTEGRATIONS_SETUP.md`
for what each gates. Enforced today via `lib/moduleGate.js#requireModuleEnabled()`,
wired into `routes/signnow.js` (all routes except `/status`) and
`routes/handoffEstimates.js` — a disabled module's routes return `404
module_disabled`, never a missing-secret error. **Not yet wired into**:
QuickBooks routes, Google Calendar/Contacts sync, the Meta/SignNow webhook
receivers, or any worker (reminder worker, calendar-outbox worker) — a
real, tracked gap; `isModuleEnabled()` is readable everywhere but only
these two routers actually gate on it so far.

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
| `GMAIL_FROM_ADDRESS` | Recommended | This installation's connected Gmail sending address — read by `lib/notificationRecipients.js#getSenderAddress()` before falling back to `admin_email` |
| `GMAIL_EXPECTED_ACCOUNT` | Only if using a non-EC Gmail account | Overrides the Gmail OAuth flow's expected-account check (`lib/gmailOAuthRouter.js`) and the credential store's fallback identifier (`lib/gmailCredentialStore.js`) — unset preserves EC's historical `yaron@ecconstructiongroup.com` literal, so a NEW installation must set this to complete Gmail OAuth for its own mailbox at all. |
| `ADMIN_OVERRIDE_EMAILS` | Recommended | Comma-separated allowlist for the public-capture admin conflict-override (`lib/captureOverrideAuth.js`) — unset preserves EC's historical yaron@/michelle@ allowlist. `lib/captureOverrideAuth.js` is deliberately DB-free/synchronous, so this is its only config surface (not `company_settings`). |
| `RAILWAY_GIT_COMMIT_SHA` | Set automatically by Railway | Deployed-commit identity shown in `GET /api/v1/system/info` — never set manually, never a hardcoded project/service UUID. |

`scripts/install/bootstrap.js`'s report tells you exactly which of the
optional integration variables are present/missing for this installation.

## Per-provider credentials (PostgreSQL, encrypted — `integration_credentials`)

OAuth tokens and connected-account state (QuickBooks realm, Gmail mailbox,
SignNow account, etc.) live here, keyed by `(provider, credential_type,
environment, account_identifier)`, encrypted with `ENCRYPTION_KEY`. This
table was already generic/per-installation before productization — no
schema change was needed. See `docs/INTEGRATIONS_SETUP.md`.

## Deferred work (tracked, not forgotten)

Phase 2 converted the highest-impact hardcoded EC values: notification
routing (10 files), default owner/routing, timezone-aware booking AND
reminder scheduling, business-hours-aware availability, the travel buffer,
reminder-email locale, frontend branding (including `brand_primary_color`,
previously stored with no reader or admin UI at all), module enforcement
(SignNow, Handoff, QuickBooks, Meta — 4 of ~8 integrations), and
admin-protection. Still deferred, real and tracked:

- Full mechanical conversion of the ~150 remaining files with a hardcoded
  `ecconstructiongroup.com` / `America/Los_Angeles` / named-person literal
  that Phase 1's audit catalogued — the vast majority are either dev/audit
  tooling explicitly scoped to EC (Category C — see
  `docs/SECURITY_MODEL.md`), test fixtures (Category D), or low-traffic
  code paths not yet converted for lack of time, not because they're
  considered safe to leave. Two specific, live (if low-risk) examples found
  during this pass: `routes/routing.js#DEFAULT_OWNER_STARTS` hardcodes EC's
  office address as the default driving-route starting point for a rep named
  exactly "Yaron Drilevich" (harmless for any other installation — the key
  simply never matches, and real values are configured per-owner via
  `PUT /owner-config`); `crm-frontend/src/components/AppointmentSlotPicker.jsx`
  hardcodes `AVAILABILITY_OWNER_EMAIL = 'yaron@ecconstructiongroup.com'`
  (EC's product decision that "Yaron's calendar is the availability calendar
  that must be shown" — a second installation needs this made configurable,
  ideally from `default_owner_email`, as a deliberate UI decision, not a
  silent side effect of a config-plumbing pass).
- Module enforcement (`lib/moduleGate.js`) on Google Calendar/Contacts sync
  and both background workers (reminder worker, calendar-outbox worker) —
  deliberately NOT extended here: unlike SignNow/Handoff/QuickBooks/Meta's
  single dedicated routers, Google Calendar is embedded throughout the
  booking write path itself, and the workers are the exact processes
  CLAUDE.md flags as never-safe-to-experiment-on (a duplicate execution can
  double-send/double-process). Needs its own careful pass.
- `locale` is read only by the reminder-email date format
  (`lib/reminderTime.js#formatDate`) — the highest-volume customer-facing
  date surface — not yet by the frontend's own date formatting
  (`crm-frontend/src/lib/formatters.js` still hardcodes `en-US`) or by every
  other backend date-display string.
- A handful of internal, display-only `AT TIME ZONE 'America/Los_Angeles'`
  SQL literals in `routes/cronJobs.js`'s own logging remain — they affect a
  log line's readability, never a stored value or customer-facing behavior.
