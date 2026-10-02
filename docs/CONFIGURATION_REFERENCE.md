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
| `timezone` | text | `America/Los_Angeles` | Read via `getCompanyConfig().timezone` / `getTimezone()`. Wired into booking-time conversion (`lib/captureValidation.js#laToUtcStart`, `lib/booking/slotBlocking.js#toUtcIso`, `routes/publicCapture.js`, `routes/metaWebhook.js`, `routes/leads.js`'s appointment booking) AND into every reminder-window/scheduling path: `lib/reminderTime.js#pacificToUtcMs`/`toLA`, `lib/reminderEngine.js`, `lib/phoneCallReminders.js`, `lib/booking/followUpReminders.js` (any follow-up's non-blocking Google Calendar reminder event (all types — Phone Call, Meeting, Text, Email, Other — permanent rule)), `lib/booking/phoneCallIntegrity.js` (admin diagnostic). Each resolves it once per run/request rather than per-lead. See `test/multiTimezoneBooking.test.js` and the timezone-propagation Phase 2 commit. A few internal SQL `AT TIME ZONE 'America/Los_Angeles'` literals in `routes/cronJobs.js`'s own display-only logging remain — tracked, low-priority (they affect a log line's readability, not any stored value or customer-facing behavior). |
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
for what each gates. Enforced via `lib/moduleGate.js#requireModuleEnabled()`
(a disabled module's routes return `404 module_disabled`, never a
missing-secret error) on `routes/signnow.js`, `routes/handoffEstimates.js`,
`routes/handoffSync.js`, `routes/qbInboundSync.js`, `routes/leadQB.js`, and
`routes/metaWebhook.js`. Google Calendar/Contacts sync has no single HTTP
entry point to gate — instead, the enqueue/write paths check
`companyConfig.isModuleEnabled()` directly: `lib/booking/calendarOutbox.js`
(both `enqueueCreate`/`enqueueUpdate`, `google_calendar`),
`lib/googleContactsOutbox.js#enqueueContactSync` (`google_contacts`), and
`scripts/calendarOutboxWorker.js` itself (checks both flags once per run
and skips the corresponding queue entirely when disabled) — so a company
that never turns on Google Calendar never attempts a Google API call from
either the request path or the worker. A disabled `google_calendar` does
NOT fail availability lookups themselves (`lib/booking/availabilityService.js`
degrades to DB-only conflict checking — see
`test/integration/moduleGateWiring.int.test.js`).

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
  considered safe to leave. A later productization pass closed the two
  highest-traffic examples that were previously listed here as live gaps:
  `routes/routing.js#DEFAULT_OWNER_STARTS` is now used ONLY internally by
  `buildOwnerRoute()`'s own travel-time estimate (a harmless, documented
  graceful-degradation fallback — never matches a non-EC rep name); the
  actual `GET`/`PUT /owner-config` and `GET /daily-schedule` API responses
  now go through `getRawOwnerStarts()`, which never merges in or exposes
  EC's address to another installation (this fix also closed a real bug:
  `PUT /owner-config` previously persisted the merged EC-default object
  into the company's own `app_settings` row on first save).
  `crm-frontend/src/components/AppointmentSlotPicker.jsx`'s
  `FALLBACK_OWNER_EMAIL`/`FALLBACK_OWNER_NAME` (formerly
  `AVAILABILITY_OWNER_EMAIL`, hardcoded) are now genuinely last-resort —
  the component fetches `default_owner_email`/`default_owner_name` from
  `GET /api/v1/company-settings` on mount and only falls back to the EC
  literal if that call fails. The same pattern (fetch once, fall back to a
  literal only on error) was applied to the public lead-capture page's
  shared availability widget: `LeadCapture.jsx` fetches `GET
  /api/public/capture/app-lists`'s new `defaultOwnerName` field and passes
  it down as a prop to `CaptureSlotGrid.jsx` (which itself stays a pure,
  prop-driven component with no fetch of its own, keeping `"Yaron"` only
  as its prop default).
  `LeadCapture.jsx`'s `DEFAULT_OWNERS` list and its form's
  `assigned_rep: 'Yaron Drilevich'` default remain hardcoded and
  deliberately deferred — that endpoint is public/unauthenticated, so
  exposing a company's real staff roster there (instead of a single
  generic default name) is a product decision about what an anonymous
  visitor should see, not a mechanical config-plumbing fix.
- Module enforcement (`lib/moduleGate.js`) now also covers QuickBooks
  (`routes/qbInboundSync.js`, `routes/leadQB.js`), the Meta webhook
  receiver (`routes/metaWebhook.js`), and `routes/handoffSync.js`, on top
  of SignNow/Handoff/estimates from Phase 2. Google Calendar/Contacts sync
  has no single router to gate (it's embedded in the booking write path
  itself), so it's enforced at each actual write/enqueue site instead —
  see "Module keys" above for the exact list — and
  `scripts/calendarOutboxWorker.js` checks both flags once per run and
  skips the corresponding queue entirely when a company hasn't enabled
  that integration, rather than attempting (and failing) a Google API call
  with no credentials. A disabled `google_calendar` was initially found to
  also break availability lookups entirely (500/503 instead of a DB-only
  fallback) — fixed; see `test/integration/moduleGateWiring.int.test.js`.
  There is no `enabled_modules` key for the reminder worker itself — it has
  always been controlled independently via `REMINDER_DRY_RUN` (see
  CLAUDE.md's "Reminders" rule); whether to add a real module flag for it
  is still open and untouched by this pass.
- `locale` is read only by the reminder-email date format
  (`lib/reminderTime.js#formatDate`) — the highest-volume customer-facing
  date surface — not yet by the frontend's own date formatting
  (`crm-frontend/src/lib/formatters.js` still hardcodes `en-US`) or by every
  other backend date-display string.
- A handful of internal, display-only `AT TIME ZONE 'America/Los_Angeles'`
  SQL literals in `routes/cronJobs.js`'s own logging remain — they affect a
  log line's readability, never a stored value or customer-facing behavior.

## Lead/Deal dropdown lists (`app_settings` key `app_lists`)

Project types, lead sources, lead statuses, and the "contact owner"
dropdown shown across Leads/Deals are read from `app_settings` (key
`app_lists`, a single jsonb value with `projectTypes`/`sources`/
`statuses`/`contactOwners` arrays) via `routes/settings.js` (authenticated
admin/manager CRUD) and `routes/publicCapture.js`'s public `GET
/app-lists` (a narrower `projectTypes`/`leadSources`/`defaultOwnerName`
subset, safe to expose with no auth). `scripts/install/bootstrap.js` can
seed this row at install time from `company.json`'s
`project_types`/`lead_sources`/`statuses`/`contact_owners` arrays (see
`docs/NEW_COMPANY_INSTALL.md`) — optional, no env-var form, and never
overwritten on a repeat bootstrap run. Omitted entirely, the frontend's
own generic constants apply (`crm-frontend/src/pages/Settings.jsx`'s
`DEFAULT_SOURCES`/`DEFAULT_CONTACT_OWNERS`, `LeadCapture.jsx`'s
`DEFAULT_SOURCES`, `LeadDetailModern.jsx`'s `DEFAULT_LEAD_SOURCES`) until
an admin saves Settings for the first time — these were previously found
to include three real EC staff first names (Sharon, Yair, Ethan) as
"universal" lead-source defaults; fixed to a generic list
(`crm-frontend/src/lib/noRealNamesInDefaults.test.jsx` guards against this
recurring).
A separate migration-level version of the same leak (`db/migrations/
2026-36-restore-lead-sources.sql` unconditionally restoring EC's own named
lead sources) is now guarded to run only when the `owners` table is
already non-empty — i.e. only on an upgrade of EC's own pre-existing
database, never on a fresh installation.

## Destructive maintenance scripts (`lib/installationIdentity.js`)

Under the productized single-tenant-per-deployment model, a script
written/tested against one company's database must not run destructively
against a different installation by accident (a copy-pasted command, a
stale `DATABASE_URL` left in a shell). Any script that writes under an
`APPLY=1`-style flag should call
`requireInstallationConfirmation(process.argv.slice(2))` before proceeding
(see `lib/installationIdentity.js`'s own header comment for the exact
usage) — it requires `--confirm-installation=<installation_id|company_name>`
matching the connected database, throwing otherwise. An unbootstrapped
database (no `company_settings` row at all — nothing yet to protect) has
no identity to match against, so any explicit non-empty value satisfies
the gate there; it still forces a deliberate, non-silent opt-in rather
than skipping the check entirely. Currently gated:
`scripts/auditAppointmentFollowUp.js` (its own pre-existing
`--confirm-host` equivalent), `scripts/revertLegacyPhoneCallConversion.js`,
and `scripts/auditPhoneCallCalendarArtifacts.js`. See
`test/destructiveScriptsInstallationGate.test.js` and
`test/installationIdentity.test.js`.
