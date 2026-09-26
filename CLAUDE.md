# CLAUDE.md — EC Construction Group CRM (qb-proxy-server)

This is the durable developer source of truth for this repository. It
reflects what was actually verified against executable code and manually
confirmed live production facts — not assumptions, not stale documentation.
When code and documentation disagree, trust code; when repository config and
manually-verified live facts disagree, trust the live facts recorded here.

## What this is

A full-stack CRM (originally a QuickBooks proxy, now the entire backend) for
EC Construction Group, running on Railway + PostgreSQL + Express, with a
standalone Vite/React frontend. **Base44 is permanently retired from the
production request path.** Do not reintroduce, restore, or design around any
Base44 dependency — see "Base44 prohibition" below.

## Canonical paths

**Backend:**
- `server.js` (repo root) — main Express app. Routes mounted via `app.use`;
  there is no `routes/index.js`. Contains, in addition to routing: the
  legacy QB-proxy passthrough surface, QB OAuth/token handling, and QB
  estimate-sync cron logic. It is a large file (~2,500 lines) mixing several
  concerns — read the relevant section rather than assuming a clean
  single-responsibility layout.
- `routes/` — one file per resource/feature, mounted from `server.js`.
- `lib/` — business logic and integration clients.
- `db/` — `client.js` (shared pool), `migrate.js` (migration runner),
  `schema.sql` (**partial legacy snapshot only — see below**),
  `migrations/*.sql` (the real schema history), `rollback/*.sql`.
- `scripts/` — mostly one-off Base44→Railway migration/audit/rollback
  tooling from the historical migration, not production runtime. One
  script, `scripts/reconcileLeads.js`, still imports `@base44/sdk` directly
  — it is a manual dev tool, never wired into any route/cron/worker, and is
  the one known remaining exception to "zero Base44" (see below).
- Root `Dockerfile`, root `package.json` — the `qb-proxy-server` API image.

**Frontend:**
- `crm-frontend/` — standalone Vite + React app. Zero `@base44/sdk`/
  `@base44/vite-plugin` dependency. Only one build mode exists:
  `vite build --mode exit` (loads `.env.exit`).
- `crm-frontend/src/` — `pages/`, `components/` (see "Frontend conventions"
  below for the three coexisting styling layers), `api/railway/*`, `lib/`.
- **`crm-frontend/Dockerfile` is the canonical frontend Dockerfile** (builds
  via `npm install && npm run build:exit`, serves via nginx). A second file,
  root `Dockerfile.frontend`, also exists in the repo and is not confirmed
  to be in active use — do not assume it is canonical; treat
  `crm-frontend/Dockerfile` as the one that matters unless told otherwise.
- `crm-frontend/package.json`, `crm-frontend/vite.config.js`.

## Production topology (manually verified — supersedes repository config)

Canonical Railway project: **`devoted-courtesy`**. Five verified production
services:

| Service | Role |
|---|---|
| `qb-proxy-server` | Backend API |
| `insightful-encouragement` | Frontend CRM SPA |
| `artistic-determination` | Reminder worker (`reminderWorker.js`) |
| `noble-illumination` | Calendar / Google Contacts outbox worker (`scripts/calendarOutboxWorker.js`) |
| Postgres | Database |

Production frontend: **`crm.ecconstructiongroup.com`**.

**KNOWN DISCREPANCY (documentation/config debt — do not "fix" by adding
infrastructure):** `railway.json` in this repo defines a 4th service,
`production-watchdog`, which does not appear in the manually-verified list
above. Do not create a `production-watchdog` service, and do not restore or
assume a service called `adaptable-cooperation` is live, based only on
`railway.json` or the file's own `_worker_isolation_notes` guesses — those
guesses have been shown to be wrong before (git history indicates
`noble-illumination` is the calendar worker, not `railway.json`'s own guess
of "likely production-watchdog"). If `railway.json` and this file disagree
about topology, this file wins; go correct `railway.json` and
`docs/PRODUCTION_ARCHITECTURE.md`, don't build around the stale version.

## Development rules

- **Never hardcode a new company-specific literal** (email domain, admin
  name, timezone, office address, brand color/name/phone) outside a
  designated company-identity configuration point. The codebase today has
  extensive existing instances of this (`ecconstructiongroup.com`,
  `America/Los_Angeles`, named individuals appear in 20+ files) — this is
  known, tracked technical debt from the multi-company readiness review;
  don't add to it, and prefer centralizing when you touch adjacent code.
- **Ownership/authorization**: three different implementations of "does
  this user own this record" exist today — `lib/authorization.js#canAccessLead`
  (used only by `routes/emails.js`), `routes/leads.js#resolveOwnerScope`
  (the real DB-level filter for lead CRUD), and `lib/dealModel.js#canAccessDeal`/
  `canWriteDeal` (used by `routes/deals.js`). When adding a new
  ownership-scoped route, reuse one of these rather than inventing a
  fourth. Several existing routes (`tasks.js`, `activities.js`,
  `invoices.js`, all four deal sub-resource routers, `dealFinancials.js`)
  currently have **no ownership check at all** beyond `requireAuth` despite
  header comments claiming scoping — this is known, tracked technical debt,
  not a pattern to copy into new code.
- **QuickBooks token refresh**: `server.js`'s mutexed, PostgreSQL-backed
  refresh implementation is canonical. `lib/qbInboundSync.js` has its own
  unmutexed refresh, and `lib/qbSyncTrigger.js` has a filesystem-based
  refresh that writes back to disk — both are known, tracked duplication
  that can race against `server.js`'s refresh (Intuit rotates the refresh
  token on each use). Do not extend `qbSyncTrigger.js`'s filesystem path;
  it likely no-ops in production today since the one-time migration deletes
  the token file it depends on.
- **Financial fields** (`lib/qbInvoiceSaleMap.js#computeSaleFinancials`):
  `balance` has always meant `PROJECT_TOTAL − PAID` ("how much is left to
  collect on the whole project"), not `INVOICED − PAID`, despite the name
  and despite some docs historically describing BALANCE as the latter. It
  is kept exactly as-is for backward compatibility (existing UI, e.g.
  `Deals.jsx`'s "Balance Due" column, already displays this exact value).
  Two additive fields now exist: `remaining` (an explicit, correctly-named
  alias of the same value — prefer this in new code) and `invoiced_unpaid`
  (the genuinely new `INVOICED − PAID` value, useful for a true
  AR/collections view). Never silently change what `balance`/`Deals.jsx`
  currently display without an explicit product decision to do so.
- **DATE-only business fields vs real timestamps**: `deals.sold_date` is
  anomalously typed `TIMESTAMPTZ` (every sibling business date —
  `work_start_date`, `close_date`, `deposit_paid_date`,
  `progress_payment_paid_date`, `final_payment_paid_date` — is a plain
  `DATE`), but it is written and read the same way: literal midnight UTC of
  the intended calendar day, with no meaningful time-of-day. A production
  check caught this rendering inconsistently — Deal Overview showed "Sold
  Date: Aug 23, 2026" while the new Deal Activity timeline showed "Deal
  Sold: Aug 22, 2026" for the identical value, because the timeline ran it
  through `lib/formatters.js#fmtDate`, which explicitly converts to
  `America/Los_Angeles` — correct for a real instant, but UTC midnight
  always rolls back to the previous Pacific calendar day for any date-only
  value. Fixed by having `lib/dealTimeline.js#buildDealTimeline` tag every
  event with `dateKind` (`'date'` — a literal `YYYY-MM-DD`, no timezone
  math at all, via `dateOnlyLiteral()` — or `'instant'` — a full ISO
  timestamp, correctly Pacific-converted at display time via the new
  `fmtBusinessDate()`/existing `fmtDate()` split in
  `crm-frontend/src/lib/formatters.js`). When adding a new date-bearing
  field anywhere in the CRM: if it is a calendar date a person picked (no
  real time-of-day), use `fmtBusinessDate`/`dateOnlyLiteral`, never
  `fmtDate`, regardless of the column's actual Postgres type.
  `AttachmentsPanel.jsx`'s QB `invoice_date` (a `DATE` column) had the same
  latent bug and was fixed the same way. Do NOT migrate `sold_date`'s
  column type to fix this — the value's semantics (a business date) are
  independent of its storage type, and a type migration is unnecessary
  schema risk for a presentation-layer bug.
- **`OverviewTab.jsx`'s "Contract Signed" field is mislabeled, not
  authoritative**: it displays `deal.deposit_paid_date` (falling back to a
  `lead.signed_contract_date` column that does not exist anywhere in the
  schema — a dead fallback) under the label "Contract Signed." This is NOT
  a genuine record of contract execution; it is the Deposit Paid Date
  wearing the wrong label, most likely a pre-SignNow-era proxy. The Deal
  Activity timeline's "Contract Signed" event is deliberately NOT wired to
  this field — doing so would duplicate the same date under two different
  labels (it already appears correctly as "Deposit Paid"), and would
  contradict a deal that has a genuine, different SignNow-verified signing
  date. The timeline only shows "Contract Signed" when a real
  `signnow_documents` row reached `signed`/`completed` for that lead;
  historical deals that predate SignNow (or were never sent through it)
  correctly show no Contract Signed event rather than a fabricated one.
  Fixing `OverviewTab.jsx`'s label/mapping is a separate, deliberate UI
  correctness decision that needs explicit product sign-off, not a
  silent side-effect of a date-timezone fix.
- **`routes/qbExecutiveMetrics.js`** aggregates revenue/paid/balance **per
  QB customer**, not per-deal, despite its header comment's original intent
  — a documented, known limitation (see the file's own header). A repeat
  customer's separate deals are conflated in this admin-only reporting
  view. Restructuring this to group by `crm_sale_id` is a real, deliberate
  change to a business-facing reporting endpoint — don't do it as a
  drive-by fix; it needs its own pass (deciding how to bucket unmapped
  invoices, and verifying the exact response shape the executive dashboard
  frontend depends on).
- **JSX in `crm-frontend/`**: this codebase has demonstrated at least one
  case (`crm-frontend/src/components/FollowUpScheduler.jsx`, fixed in this
  session) where a conditional-rendering edit left a JSX expression
  container unclosed and broke `npm run build:exit` entirely, undetected
  for many subsequent commits because nothing ran the actual production
  build. **Always run `cd crm-frontend && npm run build:exit` after editing
  any `.jsx` file**, not just a dev-server smoke check — Vite's dev server
  can be more forgiving about some malformed JSX than a full production
  build.
- **Backend/frontend response envelope contracts**: several backend routes
  return `{ deal: ... }` / `{ lead: ... }` / `{ expense: ... }` /
  `{ loanPayment: ... }` wrapper objects, not the bare record. Frontend
  consumers must unwrap (`res?.deal || res`) — this session found and fixed
  three call sites that had silently skipped the unwrap
  (`FinancialsTab.jsx`'s `updateDeal`, `ExpensesSection.jsx` and
  `LoanPaymentsSection.jsx`'s post-create activity logging). When adding a
  new call to any `railway*.update()`/`.create()` client function, check
  the actual backend route's `res.json(...)` shape rather than assuming a
  bare record.

## Database safety

- Never run a destructive script (`DELETE`, `TRUNCATE`, bulk `UPDATE`)
  against production without confirming `DATABASE_URL` first — several
  scripts (`db/importLeads.js`, `scripts/reconcileLeads.js --apply`) have
  no built-in environment guard.
- `company_settings` is an unscoped singleton — `DELETE FROM
  company_settings` deletes ALL rows (every route reads it via
  `ORDER BY created_at ASC LIMIT 1`, not by any tenant key).
- No table has DB-level uniqueness on lead email/phone — duplicate
  prevention is entirely application-level, and differs between the
  public-capture/booking path (bare last-10-digit phone matching) and the
  internal admin path (`routes/leads.js`, exact match against
  `+1XXXXXXXXXX`-normalized phone). The same customer captured through both
  paths may not be recognized as a duplicate by the admin path.
- **`db/schema.sql` is NOT a complete, canonical schema snapshot.** It only
  covers tables added through migration `2026-08`. Everything from
  `2026-09` onward (activities, deals, tasks, invoices, all `deal_*`
  financial tables, `app_settings`, `qb_invoice_sale_map`,
  `qb_invoices_cache`, and more) exists ONLY in `db/migrations/*.sql`. The
  authoritative source of truth for the full schema is
  `db/migrations/*.sql` + the `schema_migrations` table — see the header
  comment now added to the top of `db/schema.sql` for the full list of what
  it does and doesn't cover. Code paths calling `ensureSchema()` directly
  (rather than relying on `db/migrate.js` having run first) only get the
  partial subset in `schema.sql`.
- Migration filenames with duplicate date-prefixes exist (`2026-33-*` ×3,
  `2026-34-*` ×2) — apply order is alphabetical tie-break within the same
  prefix, not guaranteed intent. Check `schema_migrations` before assuming
  a specific migration has or hasn't run.
- Do not hold a DB transaction open across an external network/API call
  (Google, QuickBooks, SignNow, Gmail, Handoff). The existing booking/
  calendar-outbox code follows this correctly (network calls happen outside
  any held transaction) — match that pattern in new code.

## Deployment rules

- Push to `main` auto-deploys via Railway. **A CI workflow now exists**
  (`.github/workflows/ci.yml`) that runs the backend test suite and a real
  frontend production build (`npm run build:exit`, matching
  `crm-frontend/Dockerfile`'s own build step) on every push/PR to `main` —
  this is a pre-merge gate, not a replacement for Railway's own deploy
  pipeline, and it does not touch any live system (no DATABASE_URL, no real
  integration credentials).
- The backend Dockerfile chain (`node db/migrate.js && node server.js`)
  means a failing migration blocks the entire API from starting — treat
  every new migration as a startup-blocking risk and verify it doesn't
  error against the current schema shape before merging.
- Never restart `reminder-worker` (`artistic-determination`) or
  `calendar-outbox-worker` (`noble-illumination`) "just to verify
  something" — both are cron/loop-managed, and
  `lib/monitoring/recoveryPolicy.js` explicitly never auto-restarts them
  because a duplicate execution can cause double-sends/double-processing.

## Integration map

| Integration | Auth | Storage | Optional? |
|---|---|---|---|
| QuickBooks | OAuth2, refreshed via `server.js` (canonical — see token-refresh note above) | `integration_credentials` (Postgres, AES-256-CBC) | Env-var gated |
| Gmail | OAuth2, single hardcoded mailbox (`yaron@ecconstructiongroup.com`) | `integration_credentials` | Env-var gated, not genuinely multi-account today |
| Google Calendar/Contacts | Service account, domain-wide delegation | N/A (no per-user token) | Env-var gated |
| SignNow | API key (primary) or OAuth2 password grant (fallback) | `integration_credentials` | Env-var gated |
| Handoff | Static API key | `app_settings.handoff_api_key` or env var | Env-var gated |
| Website leads (ecconstructiongroup.com, Netlify) | Shared secret `x-webhook-secret` = `WEBSITE_LEAD_WEBHOOK_SECRET` (**fails closed** — 503 if unset) → `routes/websiteLeads.js` | `leads` (+ `sms_consent*` columns), `website_lead_receipts` (idempotency) | Env-var gated; website side needs `CRM_WEBHOOK_URL` + the same value as `WEBHOOK_SECRET` |
| Meta/Facebook Lead Ads | Webhook + `META_APP_SECRET` HMAC (**fails open** if unset — verify this env var is actually set in production before relying on it) | N/A | Env-var gated |

## Important business invariants

- **Appointments**: no-double-booking is enforced by
  `lib/booking/appointmentWriter.js#acquireOwnerLockAndCheckConflict`
  (per-owner `pg_advisory_xact_lock` + `busy_range` overlap check, in the
  same transaction as the write). Migration 2026-33 DROPPED the old
  `EXCLUDE USING gist` constraint, so there is no DB-level guard — every
  appointment write must go through `lib/booking/bookingService.js`, which
  calls it. Never insert into `appointments` anywhere else.
- **Appointment vs Follow-Up** (`lib/booking/appointmentView.js`,
  `lib/followUp.js`): the APPOINTMENT is the lead's active `appointments`
  row — the only source for Lead Detail → Appointment, Google Calendar,
  availability blocking and customer reminders. The FOLLOW-UP is
  `leads.follow_up_*` (+ notes/status), an internal next action that never
  creates/moves/cancels an appointment. Never mirror one into the other.
  This holds for EVERY follow-up type, including `'Meeting'`: a Meeting
  follow-up never books, blocks availability, gets a 1h buffer, creates a
  Google Calendar/travel event, becomes a routing stop or triggers a customer
  appointment reminder — never read `follow_up_*` as a fallback for
  `appointment_*` (guarded by `test/meetingFollowUpNotAppointment.test.js`,
  `crm-frontend/src/components/MeetingFollowUp.test.jsx` and
  `test/integration/meetingFollowUp.int.test.js`).
  Writes: `PUT /api/v1/leads/:id/appointment` vs `PUT /api/v1/leads/:id/follow-up`.
  Real-Postgres coverage: `npm run test:integration` (needs a disposable,
  migrated `TEST_DATABASE_URL`).
- **`qb_invoice_sale_map`**: `crm_sale_id` is the ONLY ownership boundary
  for a QuickBooks invoice, and a mapping is NEVER reassigned once created
  (`ON CONFLICT DO NOTHING`). Never resolve invoice ownership by amount,
  customer, or date.
- **Reminders**: default to dry-run (`REMINDER_DRY_RUN` must be explicitly
  `'false'` to send real customer-facing email); the HTTP trigger route
  force-overrides to dry-run regardless of query params as a second safety
  net — do not remove that override. Reminder worker is currently **active
  in production with real sending enabled** — do not treat it as inert.
- **Lead ownership/visibility**: admin/manager see everything; `office`
  sees everything read-only; `sales_rep` is scoped via `routes/leads.js`'s
  `resolveOwnerScope` (FK join to `owners`, resolved from the caller's JWT
  email) — a rep with no matching `owners` row fails closed.
- **Base44 is retired from the production path.** Known, now-fixed
  exceptions found and corrected in this session: `lib/reminderEmails.js`
  and `lib/reminderPages.js` previously hardcoded a live
  `media.base44.com` logo URL in customer-facing reminder emails and action
  pages (fixed to serve from `${CRM_PUBLIC_URL}/email-logo.png`, matching
  `lib/emailTemplates.js`'s existing pattern); `lib/actionRouter.js`'s CSP
  `img-src` was updated to match. `test/noBase44MediaDependency.test.js` is
  a permanent regression guard against this class of issue recurring. The
  one remaining known exception is `scripts/reconcileLeads.js`, a manual
  dev tool that still imports `@base44/sdk` — not wired into any production
  path; do not build new production logic depending on it.

## Working subsystems — do not redesign without new evidence

These have been manually/independently verified working in production, or
were fixed and verified in this session. Treat prior architecture-review
findings about them as hardening opportunities for low-frequency edge
cases, not evidence they need rework:

- **SignNow's template creation/send workflow** — visually verified
  working. Known hardening items (a partial-failure duplicate-send edge
  case, declined-signature handling) should be fixed in place if pursued,
  not treated as reasons to redesign the workflow.
- **Google Calendar sync** — currently healthy.
- **Reminder worker** — active in production with real sending enabled.
  Its three engines (appointment/phone/task reminders) are not isolated
  from each other the way the calendar-outbox-worker now is — a known
  hardening opportunity, not a sign anything is currently broken.
- **Admin Override flow** — working.
- **Base44 retirement** — independently verified for the production
  request path.
- **`crm-frontend`'s production build** (`npm run build:exit`) — was
  broken (a JSX syntax error in `FollowUpScheduler.jsx` from a prior
  commit, unrelated to this session's other changes) and has been fixed
  and verified in this session. **Always re-run this exact command after
  any `.jsx` edit.**

## Open, known-limitation items

- **Google Contacts automatic sync** — the original `routes/publicCapture.js`
  missing-`pool` `ReferenceError` (a prior session's fix, still valid) only
  covered ONE of several gaps found in a later, deeper pass. Confirmed and
  fixed in that pass (see `test/googleContactsReconciliation.test.js`):
  (1) `routes/metaWebhook.js` (Meta/Facebook Lead Ads) created leads without
  ever enqueueing contacts sync, in either its with-appointment or lead-only
  branch — leads from that source never synced at all; (2) the legacy
  `PUT /by-external/:externalRef` upsert route never enqueued either, on
  create or update; (3) **`PUT /:id`, the canonical "Edit Lead" endpoint,
  never re-enqueued sync when a lead's contact fields were edited after
  creation** — a lead was only ever synced ONCE, at creation, so a later
  phone/email/name correction left its Google Contact permanently stale
  with no automatic path to fix it (only the manual per-lead "Sync Now"
  button in `GoogleContactSyncPanel.jsx` could force a re-sync). This is the
  most likely source-level explanation for a lead whose CRM record looks
  correct but whose Google Contact/caller-ID never reflects a later
  correction. (4) `lib/googleContactsClient.js#findContact`'s phone match
  compared digit strings with `.includes()` in a way that only matched when
  the stored contact had at least as many digits as the incoming
  `+1XXXXXXXXXX`-normalized lead phone — a contact stored as a bare
  10-digit number (common for anything a human typed in without a country
  code) would never match, risking a duplicate contact instead of an
  update; fixed to compare the last 10 digits of each side. All four are
  fixed; `lib/googleContactsOutbox.js#enqueueContactSync` was also hardened
  to be genuinely idempotent (it previously inserted an unconditional new
  outbox row on every call) and to flip the lead's own
  `google_contact_sync_status` to `'pending'` on enqueue so a stale
  `'synced'`/`'error'` status is never shown while a fresh sync is
  outstanding. Migration `2026-38` adds `google_contact_synced_at`
  (written only on a real sync success, unlike `updated_at`) so
  reconciliation can detect a lead edited after its last successful sync.
  `scripts/reconcileGoogleContacts.js` classifies every lead with a phone
  or email into CONFIRMED_SYNCED / MISSING / FAILED_RETRYABLE / PENDING /
  STALE / CANNOT_VERIFY and, only with `--enqueue`, queues the ones that
  need it — it never calls the Google API directly. **Not yet verified
  against live production data or the live Google Contacts API** (no
  outbound network access in the environment these fixes were written in)
  — running `scripts/reconcileGoogleContacts.js` (report-only first, then
  `--enqueue` if warranted) against production, and checking a real device
  for the caller-ID fix, remains an open, live-environment verification
  step, not a code-level one.
- **`test/invoiceTemplateParity.test.js`** and
  **`test/railwayEmailSender.test.js`** — both structurally test comparison
  against `base44/functions/...` and `base44/shared/...` source files that
  no longer exist (correctly deleted with Base44's retirement, must not be
  recreated). Both now skip cleanly with a clear explanation instead of
  crashing; they should eventually be rewritten as self-contained
  regression tests (like `test/reminderParity.test.js`) or formally
  retired — this is tracked, not urgent.
- **`test.todo('CALENDAR: CalendarSyncPanel states are mutually
  exclusive', ...)`** in `test/systemWideRepair.test.js` — a real,
  narrow display-state question (can `isPending` and `isFailed` both be
  true briefly via the independent `queueRecord?.status` check) that needs
  a product decision, not a mechanical fix. Calendar sync is currently
  healthy; this was deliberately left as a tracked `todo` rather than
  either silently dropped or used as a reason to change working
  Calendar-adjacent UI code without confidence.

## Frontend conventions

- Three styling systems currently coexist: shadcn/ui primitives
  (`crm-frontend/src/components/ui/`), a custom composed layer
  (`crm-frontend/src/components/DesignSystem/`), and raw token-string
  exports (`crm-frontend/src/lib/design-system.js`). New work should use
  `components/DesignSystem/` built on `components/ui/` primitives — do not
  add new raw Tailwind strings or new `lib/design-system.js` token exports.
  This is a known, tracked inconsistency (visible even within a single file
  like `pages/Dashboard.jsx`, which currently mixes all three
  conventions), not a deliberate pattern to extend.
- `NAV_ITEMS_ALL` and `NAV_ITEMS_SALES_REP` in `Layout.jsx` are currently
  identical — role-based nav differentiation was scaffolded but never
  finished. Do not assume either array reflects a deliberate design
  decision.
- Before adding a new route in `App.jsx`, add it to the relevant
  `NAV_ITEMS_*` array in the same change — `/my-day`, `/automations`, and
  `/estimates` are currently routed but unreachable from any navigation, a
  known, tracked gap.
- The sidebar logo is a hardcoded local static asset (`Layout.jsx`,
  `/logo-dark.jpg`) with an explicit comment noting a prior DB-driven logo
  attempt broke in production and was reverted. Any future attempt to make
  branding configurable per company must account for why that failed
  (likely a missing fallback/cache-busting strategy) rather than repeating
  it blindly.

## Multi-company direction

Target: **one shared codebase, one separate deployment (Railway project +
Postgres + secrets) per company** — NOT shared-database multi-tenancy. The
schema has zero tenant-scoping columns today (confirmed: no `company_id`/
`tenant_id`/`org_id` anywhere in `db/migrations/*.sql`), and the known
authorization gaps documented above would become cross-company data leakage
risks under a shared-DB model — per-deployment isolation avoids that
entirely. The prerequisite for onboarding a second company is consolidating
today's ~20+ files of hardcoded company identity (domain, admin emails,
timezone, office location, branding — see "Development rules" above) into a
single configuration surface, backed by a `company_settings` row and a
corresponding admin-facing "Company Setup" UI, built together as one
feature — not attempted while onboarding an actual second company.

## Verification requirements

Before claiming any change is "production-ready," verify against actual
executable code and, where possible, actually run it — this repository has
demonstrated multiple cases where documentation, comments, or even test
file names claimed something was true or covered when it wasn't (a
`base44.app` frontend URL claimed alongside a "zero Base44" claim; several
test files that silently never ran at all due to a missing `node:test`
import, undetected until this session; a production build that had been
silently broken for 15+ commits). Reconcile docs against code, and code
against an actual run of it, before trusting either.

## Base44 prohibition

Do not use, restore, recommend, or design any Base44 dependency in new
work — as runtime, backend, frontend, API, SDK, auth, storage, database,
worker, cron, integration, deployment mechanism, or fallback/migration
bridge. Base44-referencing comments in the codebase document what was
replaced, not a live integration point, with the narrow, explicitly-tracked
exception of `scripts/reconcileLeads.js` noted above.
