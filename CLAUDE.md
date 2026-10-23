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
- `scripts/` — Railway-native operational tools: `calendarOutboxWorker.js`
  (the `noble-illumination` worker), reconciliations/backfills, and local
  dry-runs. The one-off Base44→Railway migration/rollback/audit tooling (46
  scripts incl. `reconcileLeads.js`/`migrationHelpers.js`) and the
  `POST /api/v1/cron/system-wide-reconciliation` endpoint that shelled out to
  one of them were removed once proven unreferenced — the migration is
  complete and git history keeps them.
- There is **no top-level `src/`**: it held stale, divergent copies of
  `server.js`, `routes/routing.js`, `routes/signnow.js`,
  `lib/googleMapsClient.js` and four frontend files (never in any image or
  service) and was deleted; `test/intakeLockingAndCanonicalTree.test.js`
  keeps it (and any image/service/require pointing at it) from returning.
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
- **QuickBooks token refresh**: `lib/qbTokenManager.js` is the ONE refresh
  implementation (server.js routes/crons, `lib/qbInboundSync.js`, and
  `lib/qbSyncTrigger.js` through it). The persisted credential is the source
  of truth (re-read each call); a refresh is single-flight per process and
  across processes (Postgres advisory lock, credential re-read under the
  lock so a token another holder just rotated is reused, never rotated
  twice), and always persists the rotated refresh token AND its expiry.
  Previously server.js (in-memory) and qbInboundSync (DB, unlocked) both
  refreshed on the same 15-minute cron minute; Intuit rotates refresh tokens,
  so server.js was left with a stale pair (`/health` showed tokenExpired=true
  from that stale copy; its next refresh risked invalid_grant → "revoked").
  `/health` now reads the persisted credential; `tokenExpired` refers only to
  the 1-hour access token, refreshed on the next QuickBooks call, and
  `accessToken` spells the state out (`valid` / `expired_refreshes_on_next_use`
  / `refresh_expired` / `none`). Never add a second refresh path.
- **QuickBooks API calls**: every authenticated QuickBooks request goes
  through `qbTokenManager.qbApiRequest` (server.js `qbFetch`, the PDF routes,
  `qbInboundSync.qbQuery`, `qbSyncTrigger`). It uses a valid (auto-refreshed)
  token and, on a 401, forces ONE canonical refresh and retries the request
  once — never a loop. Refresh: Intuit 429/5xx get a bounded retry (3
  attempts, backoff) and are recorded as transient, never as revoked; only
  `invalid_grant`/`token_revoked` (a non-5xx refusal) marks the credential
  revoked, emails `ALERT_RECIPIENTS` once a day, and makes `reconnectRequired`
  true (admins also see a CRM banner linking to `/integrations`). The refresh
  result is compare-and-swapped against the stored refresh token so it never
  overwrites a newer grant; the OAuth callback saves under the same advisory
  lock (`saveAuthorizedTokens`). `/qb/health?verify=1` (proxy secret or JWT
  only) proves real access with a read-only companyinfo call;
  `credentialStatus` and `lastSuccessfulApiCallAt` are always reported.
  Reconnect is OAuth re-consent only — never stored Intuit usernames or
  passwords, never browser automation. `test/qbTokenManager.test.js` fails on
  any raw `Bearer ${…access_token}` QuickBooks fetch outside the manager.
- **Completed follow-ups are never Overdue**: every overdue indicator (Leads
  list, Kanban, My Day, Follow-Ups widget) skips `follow_up_status =
  'completed'`.
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

- **`ENCRYPTION_KEY` rotation (added during the October 2026 Railway
  security-disclosure response)**: `lib/integrationCredentialStore.js`
  (the encrypted store behind every QuickBooks/Gmail/SignNow/Handoff OAuth
  credential) supports a second key version — `ENCRYPTION_KEY_V2` — without
  touching the original `ENCRYPTION_KEY`. `CURRENT_KEY_VERSION` (which
  version NEW writes use) is driven by `ACTIVE_ENCRYPTION_KEY_VERSION`
  (default `1` — unset means zero behavior change). **Never remove or
  change the original `ENCRYPTION_KEY` while any `integration_credentials`
  row's `key_version` is still `1`** — doing so makes that row permanently
  undecryptable. `scripts/rotateEncryptionKey.js` is the report-first
  (`--apply --confirm-host=<host>` to write) migration tool: it decrypts
  each row under its own stored `key_version`, re-encrypts under the
  target version, verifies the round-trip BEFORE writing, and is
  idempotent (a row already at the target version is skipped). See that
  script's own header for the full 7-step coordinated rotation procedure
  (add `ENCRYPTION_KEY_V2` → deploy → migrate rows → verify zero remain on
  the old version → only then flip `ACTIVE_ENCRYPTION_KEY_VERSION=2` →
  only then is the old `ENCRYPTION_KEY` safe to retire). Real-Postgres
  coverage: `test/integration/rotateEncryptionKey.int.test.js`; pure unit
  coverage: `test/encryptionKeyRotation.test.js`.
- Never run a destructive script (`DELETE`, `TRUNCATE`, bulk `UPDATE`)
  against production without confirming `DATABASE_URL` first — several
  scripts (e.g. `db/importLeads.js`) have no built-in environment guard.
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
- **No DDL at runtime.** `db/schema.sql` is executed ONLY by `db/migrate.js`
  (deploy time, under its advisory lock), which records its checksum as
  `schema_migrations.__base_schema__`; runtime `ensureSchema()` is then a
  single SELECT. Never add `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (or other
  DDL) to a request/worker path — it takes an AccessExclusiveLock even as a
  no-op. Use `db/client.js#ensureColumns` (catalog check first). Re-running
  schema.sql on every process start (the reminder worker is a fresh process
  every 15 min) caused a real intake deadlock: DDL held `reminder_leads` and
  wanted `owners` while a capture transaction held `owners` and wanted
  `reminder_leads` → "Submission failed".
- **Lead intake lock order**: every lead-creating transaction
  (`bookingService.createBooking`, admin `POST /api/v1/leads`) FIRST takes
  `leadResolution.lockLeadIdentity` (sorted, transaction-scoped advisory locks
  on normalized phone / email / external_ref / idempotency key), THEN lead
  rows, THEN the owner-schedule lock, THEN writes. This is what makes
  simultaneous same-person / same-delivery / same-key submissions resolve to
  one lead (duplicate detection alone cannot lock a row that doesn't exist
  yet). `createBooking` also retries a transaction a bounded 3 times on
  40P01/40001 as defense in depth — never a substitute for lock order.
  Real-Postgres proof: `test/integration/leadIntakeConcurrency.int.test.js`.
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
| QuickBooks | OAuth2, refreshed only via `lib/qbTokenManager.js` (see token-refresh note above) | `integration_credentials` (Postgres, AES-256-CBC) | Env-var gated |
| Gmail | OAuth2, single hardcoded mailbox (`yaron@ecconstructiongroup.com`) | `integration_credentials` | Env-var gated, not genuinely multi-account today |
| Google Calendar/Contacts | Service account, domain-wide delegation | N/A (no per-user token) | Env-var gated |
| SignNow | API key (primary) or OAuth2 password grant (fallback) | `integration_credentials` | Env-var gated |
| Handoff | Static API key | `app_settings.handoff_api_key` or env var | Env-var gated |
| Website leads (ecconstructiongroup.com, Netlify) | Shared secret `x-webhook-secret` = `WEBSITE_LEAD_WEBHOOK_SECRET` (**fails closed** — 503 if unset) → `routes/websiteLeads.js` | `leads` (+ `sms_consent*` columns), `website_lead_receipts` (idempotency) | Env-var gated; website side needs `CRM_WEBHOOK_URL` + the same value as `WEBHOOK_SECRET` |
| Meta/Facebook Lead Ads | Webhook + `META_APP_SECRET` HMAC (**fails CLOSED (503) if unset** — fixed during the Oct 2026 Railway-incident security pass; previously failed open, silently accepting unsigned payloads. Regression coverage: `test/metaWebhookFailClosed.test.js`) | N/A | Env-var gated |
| Twilio SMS (two-way, customer-facing) | `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + `TWILIO_MESSAGING_SERVICE_SID` (A2P, preferred) or `TWILIO_FROM` (bare number) — the SAME env vars `lib/reminderAlerts.js`'s internal staff-alert SMS and `lib/systemHealthChecks.js#checkTwilio`'s health probe already used before this | `sms_messages` (two-way log), `sms_opt_outs` (phone-level STOP/START registry) | Env-var gated (`sms` module in `enabled_modules` — pre-existing key, previously unused by any customer-facing route) |

## Automated appointment SMS (confirmation + 12h/2h reminders, two-way replies)

Built October 2026, NOT YET ACTIVATED in production — see the activation
gates below. Wording is the business owner's own exact given text (not
Claude-authored) — see `lib/smsTemplates.js`'s header for the one-time
approval record.

- **Templates**: `lib/smsTemplates.js` is the ONE place the three message
  bodies live (`bookingConfirmation`, `reminder12h`, `reminder2h`). Never
  duplicate wording at a call site.
- **Booking confirmation**: `lib/booking/bookingService.js#createBooking`
  fires it as a post-commit, fire-and-forget best-effort call (never inside
  the transaction — never holds a DB transaction across the Twilio network
  call) exactly once per genuine new booking (`idempotent: false &&
  appointment` — inherits createBooking's own idempotency_key mechanism, so
  a replayed booking request never double-sends). Covers every booking path
  uniformly (admin, public capture, Meta webhook) since they all funnel
  through this one function.
- **12h/2h reminders**: added to the EXISTING email reminder engine
  (`lib/reminderEngine.js`), reusing its proven Postgres claim/lease
  primitives — but under a DISTINCT claim-key namespace
  (`smsReminderKey`, `sms-reminder:...` vs email's `reminder:...`) so the
  two channels' outcomes are fully independent (an email failure never
  blocks the SMS and vice versa). Deliberately NOT a "catch-up" the way
  email's `isCatchUp` is: a short-notice booking that skips past a window's
  target time simply never gets that SMS (no stale "in 12 hours" message
  sent late) — only the booking confirmation above is unconditional. The
  30-minute window stays email/staff-only; SMS is 12h/2h, customer-only,
  per the given spec.
- **THREE ACTIVATION GATES, intentionally separate from each other**:
  1. `enabled_modules.sms` (`lib/moduleGate.js`) — the PRE-EXISTING flag
     that already gates the manual Lead Detail compose panel. May already
     be `true` in production.
  2. `SMS_AUTOMATED_REMINDERS_ENABLED` (env var, default unset/false) — a
     SEPARATE, NEW kill switch checked independently in `bookingService.js`
     AND `reminderEngine.js` — gates ONLY the booking-confirmation SMS and
     the 12h/2h reminder SMS sends.
  3. `SMS_REPLY_NOTIFICATIONS_ENABLED` (env var, default unset/false) — a
     THIRD, independent kill switch checked in `lib/smsReplyNotify.js` only
     — gates ONLY the two inbound-reply side effects (`notifyAssignedRep`/
     `notifyUnmatchedForReview` and `forwardToYaronBestEffort`).
  Gates 2 and 3 were originally the SAME switch; split apart (October 2026,
  live-SMS end-to-end verification pass) because that coupling made it
  impossible to live-test an inbound reply's rep-notify/Yaron-forward
  behavior without simultaneously arming real confirmation/reminder sends
  for every live upcoming appointment — exactly the accidental blast-radius
  this gate philosophy exists to prevent. Each surface now has its own
  explicit opt-in; turning one on never turns the other on
  (`test/smsReplyNotify.test.js`'s two "decoupled gate" tests are the
  permanent regression guard against re-coupling them). This exists
  specifically so deploying this code can never itself start automated
  customer sends just because `sms` was already on for manual messaging —
  an operator must take a deliberate additional step per surface they want
  active. Mirrors `REMINDER_DRY_RUN`'s existing safe-by-default precedent.
  Gate 1 plus the relevant one of gate 2/3 must both be true for a given
  surface to send.
- **Two-way replies**: reuses the EXISTING inbound webhook
  (`routes/sms.js`, `lib/smsService.js#handleInboundMessage`) completely
  unchanged for matching/consent/opt-out/dedup. Two NEW side effects fire
  on an ordinary (non-keyword), non-duplicate inbound reply, AWAITED before
  the TwiML response (not fire-and-forget — Twilio tolerates a few seconds
  of webhook latency, and awaiting is what makes "one notification per
  message, no duplicate on retry" an actual guarantee rather than a race):
  - `lib/smsReplyNotify.js#notifyAssignedRep` — emails the lead's REAL
    owner, resolved via the `owners` FK (`leads.owner_id` → `owners.email`/
    `display_name`), never the heuristic firstname@domain reconstruction
    used elsewhere for display-only purposes — a rep's name/email in this
    notification must never be guessed. No owner assigned → no-op, never
    invents a recipient.
  - Zero or ambiguous lead match → `notifyUnmatchedForReview` instead,
    routed through the EXISTING `notificationPreferences` `ACTIVITY`
    category (so Michelle's single-category policy correctly excludes her
    via the same mechanism as every other staff broadcast — no new
    category/migration needed).
  - `forwardToYaronBestEffort` — **MANDATORY per the given spec, but
    HARD-GATED behind its own `SMS_REPLY_FORWARD_TO` env var with NO
    hardcoded default destination anywhere.** SAFETY FINDING: this codebase
    already hardcodes `(310) 310-4108` in several places
    (`lib/reminderEngine.js`, `lib/actionRouter.js`,
    `lib/phoneCallReminders.js`, `lib/reminderPages.js`) as EC's PUBLISHED
    OFFICE PHONE NUMBER shown to customers — this is NOT, by itself,
    evidence it is Yaron's own SMS-capable phone, nor that it differs from
    whatever `TWILIO_FROM`/Messaging-Service sender is configured. Before
    ever setting `SMS_REPLY_FORWARD_TO`, confirm directly with Yaron: (a) it
    is SMS-capable, (b) it is NOT the outbound customer-SMS sender number,
    (c) he can actually receive texts there today. A built-in LOOP GUARD
    refuses to forward (logs `destination_equals_sender`, never sends) if
    the configured destination normalizes to the same number as
    `TWILIO_FROM` — but when sending via `TWILIO_MESSAGING_SERVICE_SID`
    (a pooled sender), the actual sending number can't be checked this way;
    this is logged as an unverifiable case, not silently assumed safe.
- **Quiet hours — NOT bypassed, ever; a blocked reminder is DEFERRED and
  retried, never dropped and never sent stale (approved October 2026).**
  All three automated messages go through the SAME `smsService.sendSms`
  consent/opt-out/quiet-hours gate as the manual panel — no special-case
  bypass. For the 12h/2h reminders specifically, a `quiet_hours` rejection
  is RETRYABLE, not terminal (`lib/reminderEngine.js`'s SMS claim loop uses
  `markFailed` with a 15-minute backoff, reusing the SAME Postgres claim/
  lease primitives the email engine already proved — never a new
  mechanism): the loop re-checks quiet hours on every subsequent run, right
  up until the appointment itself starts. Eligibility for SMS is
  DELIBERATELY WIDER than email's narrow ~25-minute match window — "target
  time has passed AND the appointment hasn't started yet" — specifically
  so a quiet-hours retry has somewhere to land. The moment the appointment
  starts, any claim still stuck retrying is explicitly closed out
  (`markSkippedNoRecipient`, logged "no compliant sending window remained")
  — never retried past that point, never silently stuck forever.
  Non-stale wording: 12h's message is already absolute (date + time), so a
  deferred send needs no wording change. 2h's normal wording ("in 2 hours")
  would become misleading once sent late — a deferred 2h send uses a
  separate, absolute-time variant (`lib/smsTemplates.js#reminder2h`'s
  `deferred: true` path — "is today at {time}") instead, mirroring the
  email engine's own proven `isCatchUp` non-stale-wording pattern. Never
  sends a second reminder for the same window once one succeeds (the claim
  mechanism's own dedup, unchanged) and never retries once the appointment
  has started.
- **Known, accepted limitation inherited from the email engine's own claim
  design (not introduced by this work)**: the claim key is keyed by
  `appointment_date` only, not time. A same-day reschedule to a different
  time AFTER a reminder for that date already fired will not get a fresh
  reminder for the new time — the claim is already `'sent'` and is never
  re-claimed. A reschedule to a DIFFERENT DATE is unaffected (fresh claim
  key, fresh windows). This is a pre-existing characteristic of
  `lib/reminderEngine.js`'s claim design, shared identically by email.
- Cancellation / Closed Lost / terminal-lost: no new code needed — SMS
  windows are computed from the SAME `leads` array
  (`crmRepository.listEligibleLeads()`) the email engine already filters
  per the Terminal-lost transition rule above; a lead absent from that
  array gets neither channel.
- Regression coverage: `test/smsTemplates.test.js`,
  `test/bookingSmsConfirmation.test.js`, `test/reminderEngineSms.test.js`,
  `test/smsReplyNotify.test.js`,
  `test/reminderEngineQuietHoursDeferral.test.js` (quiet-hours retry-vs-
  terminal branching, source-level — the loop is entangled with a live
  Gmail token refresh and can't be driven standalone; the claim primitives
  it reuses are the same ones the pre-existing email reminder suite already
  exercises against real Postgres) (unit); real-Postgres:
  `test/integration/smsReplyNotifications.int.test.js`.

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
  follow-up never books, blocks availability, gets a 1h buffer, creates an
  appointment-style Google Calendar main/travel event, becomes a routing stop
  or triggers a customer appointment reminder — never read `follow_up_*` as a
  fallback for `appointment_*` (guarded by
  `test/meetingFollowUpNotAppointment.test.js`,
  `crm-frontend/src/components/MeetingFollowUp.test.jsx` and
  `test/integration/meetingFollowUp.int.test.js`). It DOES get its own
  separate, non-blocking Google Calendar *reminder* event — see "Follow-up
  calendar visibility" below; that is a different, additive mechanism from
  the appointment's busy/blocking calendar sync and never affects
  availability, routing, or appointment reminders.
  **Dashboard "Today's Work" double-count** (production report, lead "Roger
  Dayan"): because a lead can legitimately carry both an active Appointment
  and an independent Follow-Up, `crm-frontend/src/components/
  FollowUpsWidget.jsx` buckets them as two separate entries — correct when
  they really are two actions, wrong when the Follow-Up is just the same
  appointment recorded a second time (e.g. entered via Follow-Up / Next
  Update instead of the Appointment editor, the same root pattern
  `scripts/auditAppointmentFollowUp.js` classifies as MIRROR/MIRROR_UNPROVEN
  on the backend). Fix: `FollowUpsWidget.jsx#isFollowUpMirrorOfAppointment` —
  a DISPLAY-only check (never reads/writes the database) that suppresses the
  Follow-Up entry ONLY when it is an exact mirror of the lead's own
  Appointment: same date, same time, `follow_up_type === 'Meeting'` (a real
  Appointment is never a Phone Call), and no `follow_up_notes`. ANY
  difference — a different date, a different time, or notes present — means
  both entries still render; this is deliberately narrower than the
  backend's own MIRROR match and never auto-merges on timestamp alone. A
  genuinely independent same-day or different-day pair (the "Jamey Corey"
  shape — an appointment on one day and an unrelated future follow-up on
  another) is unaffected and still shows both. This is presentation-only: it
  does not clear, delete or modify `follow_up_*`/`appointment_*` on any
  record — a provably-safe (migration/pre-separation provenance) DATA-level
  MIRROR is still only ever cleared by `scripts/auditAppointmentFollowUp.js
  --apply`, and an unproven one only by a human-confirmed
  `--promote=<lead_id>` (DIV_OTHER) or by direct review — never automatically
  from the dashboard. Regression coverage (both shapes):
  `crm-frontend/src/components/FollowUpsWidget.test.jsx`. Verified consistent
  with `/my-day` (`crm-frontend/src/pages/MobileDayView.jsx`): that page
  never lists a Follow-Up as its own row at all (it lists Appointments only,
  for driving/routing, plus a single aggregate overdue-follow-up count), so
  it has no equivalent duplicate-row risk to begin with — both surfaces
  render at most one obligation per real event. Known narrow limitation
  (documented in `FollowUpsWidget.jsx`, not fixed): this check treats any
  active appointment as kind `'Meeting'`, same as the backend does for every
  current row, but unlike the backend it has no per-row signal for the rare,
  shrinking legacy unbuffered ("Phone Call"-kind) appointment rows — a
  same-date/time/no-notes Meeting follow-up next to one of those could be
  suppressed here where the backend's own classifier would call it
  DIVERGENT; this is display-only and never hides anything from Lead Detail,
  which always shows both records.
  Writes: `PUT /api/v1/leads/:id/appointment` vs `PUT /api/v1/leads/:id/follow-up`.
  Real-Postgres coverage: `npm run test:integration` (needs a disposable,
  migrated `TEST_DATABASE_URL`). It runs the files one at a time because
  they share one database and one global calendar-outbox queue, which each
  file drains with its own fake Google client (a parallel file could process
  another file's job); the intake concurrency suite fires its submissions
  genuinely in parallel inside the file.
- **Appointment blocking rule** (canonical, do not change): an appointment
  blocks 1h before + its duration + 1h after (12:00–13:00 blocks 11:00–14:00);
  a new appointment is checked as its own actual window against that block,
  so touching a boundary is allowed (14:00 books, 13:59 does not). The
  availability grid and the write-path conflict check apply the same rule —
  `test/integration/appointmentBufferBoundary.int.test.js` compares them slot
  by slot. A Phone Call FOLLOW-UP keeps its reminder emails (owner, this
  installation's configured staff recipients narrowed by the REMINDER
  notification-preference category, and the customer — decided, keep) but
  never blocks, buffers or travels (`test/integration/phoneCallFollowUp.int.test.js`).
  **Michelle single-category policy (superseded the old "Michelle always
  copied" behavior this bullet used to describe):** EC's
  michelle@ecconstructiongroup.com is now restricted to exactly ONE
  CRM-generated email category — a genuinely new lead — across every
  notification pathway (`lib/notificationPreferences.js#CATEGORIES`,
  seeded by `db/migrations/2026-62-michelle-single-category-notifications.sql`).
  She remains in `company_settings.notification_recipients` (so she is still
  a NEW_LEAD recipient and still a valid "staff recipient" candidate
  everywhere that category applies), but every other category — appointment,
  follow_up, reminder, overdue, estimate, invoice_payment, contract_signed,
  sold, system_failure, status_change, lead_update, activity, deal — is
  explicitly disabled for her. This is notification-only DATA, never a
  permissions/role change. `lib/crmActivityNotifier.js#ACTION_CATEGORIES`
  maps every admin-activity action to a category;
  `lib/phoneCallReminders.js`, `lib/actionRouter.js` (reschedule-request
  recipient) and `routes/cronJobs.js`'s `/notify-crm-activity` were the
  staff-broadcast call sites that still used an unfiltered recipient
  resolver (`getPrimaryRecipient()`/`getRecipients()`) when this policy was
  added — now all narrowed via
  `notificationPreferences.filterRecipientsForCategory()`, same as every
  other staff broadcast (`test/notificationPreferenceCoverage.test.js`'s
  structural guard only catches `getAllStaffRecipients()` callers, not
  these two unfiltered-resolver shapes — review a new staff-facing email by
  hand for the same gap, not just by running that guard).
- **Google Calendar attendee membership is NEVER gated by an email
  notification preference (PERMANENT RULE, production incident fix)**:
  Michelle reported appointments previously visible on her Google Calendar
  — including ones expected that day — had disappeared. Root cause:
  `lib/booking/calendarOutbox.js`'s `enqueueCreate`/`enqueueUpdate` (real
  Appointments) and `lib/booking/followUpReminders.js`'s Meeting
  follow-up representation both computed the Google Calendar event's staff
  attendee list via `notificationPreferences.filterRecipientsForCategory(...,
  CATEGORIES.APPOINTMENT / CATEGORIES.FOLLOW_UP)` — the SAME mechanism that
  decides whether a staff member receives a CRM-generated EMAIL. This was
  dormant (every staff member had every category enabled) until the
  Michelle single-category policy above correctly disabled her
  `appointment`/`follow_up` EMAIL categories, at which point it ALSO
  silently dropped her from the Google Calendar invite's attendee list for
  every appointment/meeting-follow-up created or updated afterward —
  removing an attendee from an updated Google event removes the event from
  their calendar entirely, and a newly created event simply never reached
  her. Fixed by decoupling the two concerns completely: calendar attendee
  membership is now ALWAYS `lib/notificationRecipients.js#getAllStaffRecipients()`
  UNFILTERED, in both files — `notificationPreferences` governs EMAILS
  only (every genuine staff-broadcast email call site —
  `lib/crmActivityNotifier.js`, `lib/actionRouter.js`, `lib/reminderEngine.js`,
  `lib/reminderNotifications.js`, `routes/emails.js`,
  `lib/phoneCallReminders.js` — is untouched by this fix and still
  correctly filters). `test/notificationPreferenceCoverage.test.js`'s
  structural guard (every `getAllStaffRecipients()` caller must also call
  `filterRecipientsForCategory()` in the same file) now carries an explicit,
  documented exception for these two files — they build a calendar
  ATTENDEE list, never an email recipient list, so the guard's premise does
  not apply to them. A one-time, report-first/`--apply`-gated restoration
  tool, `scripts/auditCalendarAttendeeOmissions.js`, finds any active
  appointment whose most-recently-sent Google Calendar payload is missing a
  currently-configured staff recipient (generalized beyond Michelle — it
  checks every configured staff recipient, since the same bug could have
  silently affected anyone whose category was ever disabled while it
  existed) and, only with `--apply`, re-enqueues a corrective `update_main`
  through the exact same (now-fixed) canonical path, re-inviting the
  previously-omitted staff member to the existing event — never
  cancels/recreates/deletes anything, and never touches a
  completed/cancelled/no_show/rescheduled appointment. Real-Postgres
  coverage: `test/integration/calendarAttendeesIgnoreEmailPreferences.int.test.js`
  (proves the live create/update/meeting-follow-up paths are now immune —
  confirmed to fail against the pre-fix code before verifying the fix makes
  it pass) and `test/integration/auditCalendarAttendeeOmissions.int.test.js`
  (the restoration tool's report-only/`--apply`/idempotent-re-run behavior).

  **IMPORTANT LIMITATION of the DB-only audit mode (found when a production
  run reported `omission_count=0` while the incident was still visibly
  ongoing)**: the default mode of `scripts/auditCalendarAttendeeOmissions.js`
  only inspects `calendar_outbox.payload` — the request body WE most
  recently wrote to OUR OWN DATABASE. A clean result proves only that the
  last row we wrote for every active appointment lists every staff member;
  it does NOT prove that row was ever actually delivered to Google (the
  outbox row's own `status` could still be `'pending'`/`'failed'`/`'dead'` —
  the default mode never surfaces this), nor that Google's live event
  currently reflects it — our write and Google's resulting state can
  diverge. **`--verify-live`** (new) closes this gap: for every active
  appointment with a `google_event_id`, it calls the live Google Calendar
  API (`googleCalendarClient.getEvent` — the same function
  `reconcileSyncedAppointments` already uses) and compares Google's ACTUAL
  CURRENT attendees against every configured staff recipient, independent
  of what our database claims was sent — distinguishing three outcomes per
  appointment: `attendee_missing` (event exists, live attendees really are
  short a staff member), `event_missing` (the event no longer exists on
  Google at all — a different, more serious class of problem), and
  `check_failed` (the live API call itself failed — never conflated with a
  real omission, same "API failure is not proof of deletion" philosophy as
  `reconcileSyncedAppointments`). Read-only — calls only `getEvent` (a GET),
  never create/update/cancel — so it needs no `--confirm-host`. Separately,
  a genuine, documented, NOT-yet-addressed risk found while investigating
  this: `lib/booking/googleCalendarClient.js#updateEvent` (used for every
  `update_main`/`update_travel` outbox action, including this restoration
  tool's own `--apply` corrective update) never passes Google's
  `sendUpdates` parameter at all, unlike `createOrUpdateEvent`'s explicit
  `sendUpdates=all` support on first creation — a plausible, code-confirmed
  reason a corrective re-add of a previously-removed attendee might not
  properly (re)notify/resurface the event for them. Deliberately NOT fixed
  in the same pass: doing so for every routine `update_main` (not just a
  one-time correction) would also make the CUSTOMER — also an attendee on
  every main event — receive a notification email on every single ordinary
  appointment edit, a real customer-facing behavior change requiring its
  own explicit product decision, not a silent side effect of a staff-
  visibility bug fix. Real-Postgres coverage:
  `test/integration/auditCalendarAttendeeOmissionsLiveVerify.int.test.js`
  (all three outcomes, and proof it never calls a write method on the fake
  Google client) and a CLI-wiring test in
  `auditCalendarAttendeeOmissions.int.test.js` (confirms `--verify-live`
  degrades to `check_failed` per row rather than crashing when Google
  credentials are unavailable).

  **Historical forensics tool (production run showed `--verify-live`
  omission_count=0, but the incident was not considered resolved on that
  basis alone)**: a clean `--verify-live` result only covers CURRENTLY
  ACTIVE appointments — by design, since only an active appointment is
  something a corrective `--apply` could still fix. It says nothing about
  appointments that are now completed, cancelled, rescheduled/superseded,
  or that never got a `google_event_id` at all during the incident window,
  nor does it distinguish a legitimate terminal-lost cancellation from one
  needing review. `scripts/auditCalendarIncidentHistory.js` fills this
  gap — **pure read-only, no `--apply` flag exists in this script at all**
  (it issues no SQL besides `SELECT` and calls no Google API at all, so it
  cannot send an invitation, cancel, or update anything):
  `node scripts/auditCalendarIncidentHistory.js [--since=2026-10-16] [--until=2026-10-20] [--limit=500] [--json]`.
  Reports: (1) `coverage` — the TRUE total count of currently-active
  appointments (synced vs. never-synced), so a prior `--verify-live` run's
  own `--limit` can be checked against the real total rather than assumed
  sufficient; (2) every appointment created OR updated in the window,
  classified as `active` / `completed` / `no_show` / `rescheduled_superseded`
  / `cancelled_terminal_lost` (a cancellation whose lead's status is in
  `TERMINAL_LOST_STATUSES` AND has a matching "Lead marked `<status>`"
  activity note near the same time — note `bookingService.cancelAppointment`'s
  `actor` is always a human email either way, for the terminal-lost
  auto-cancel included — see `routes/leads.js`'s `cancelActiveAppointmentsForTerminalLost`
  call sites — so `actor` alone can never distinguish a legitimate
  automated cancellation from a manual one; the activity note is the one
  reliable signal) or `cancelled_needs_review` (cancelled without that
  signature — not necessarily a bug, just not explained by the terminal-
  lost automation, so a human should read its attached
  `appointment_events` trail); (3) `attendee_history` — for every window
  appointment that ever had a `google_event_id`, replays its FULL
  `calendar_outbox` `create_main`/`update_main` payload history in order
  and flags, per configured staff recipient, a genuine mid-flight
  attendee removal (present in an earlier payload, absent from a later
  one, before any cancellation) with the exact timestamp — explicitly
  never conflated with a full event cancellation, which is its own,
  separate classification above, not an "attendee removal"; (4)
  `without_google_event_id` — appointments that never synced to Google at
  all, a different gap class entirely. Real-Postgres coverage:
  `test/integration/auditCalendarIncidentHistory.int.test.js` (all five
  classification/analysis shapes against real Postgres fixtures) plus pure
  unit tests for the classification/analysis functions in
  `test/auditCalendarIncidentHistory.test.js`.

  **Unsynced-active breakdown (production run showed `total_active=879`,
  `total_active_synced=574`, `total_active_unsynced=305`)**: that single
  number cannot say whether the 305 are expected, historical debt, or an
  active ongoing failure — `scripts/auditUnsyncedActiveAppointments.js`
  (pure read-only, no `--apply`, only `SELECT`, never calls the Google
  Calendar API) classifies every currently-active appointment with no
  `google_event_id` into: `legacy_phone_call` (by design — a legacy
  unbuffered Phone Call row never gets a main event at all, per
  `enqueueCreate`/`enqueueUpdate`'s own early-return — not a sync gap of any
  kind); or, for a real Meeting/Site-Visit, `never_enqueued` (zero
  `calendar_outbox` create_main/update_main rows ever — most likely created
  while `google_calendar` was disabled, or predating the outbox system),
  `queued_not_yet_processed` (`calendar_sync_status` still `pending`/
  `processing` with outbox history — expected to be near-zero on anything
  more than a few minutes old), `retrying` / `failed` (a genuine, currently
  or permanently failing sync — ACTIONABLE), or `synced_anomaly`
  (`calendar_sync_status='synced'` with a still-NULL `google_event_id` —
  should be impossible; never folded into a normal bucket if found). Also
  reports an `created_at` age-bucket distribution of the unsynced set and
  `outbox_status_counts_global` (every `calendar_outbox` row by status,
  across the whole table) — the worker-processing visibility
  `auditCalendarIncidentHistory.js` does not surface at all.
  `node scripts/auditUnsyncedActiveAppointments.js [--limit=2000] [--json]`.
  Real-Postgres coverage: `test/integration/auditUnsyncedActiveAppointments.int.test.js`
  (every classification bucket, including the should-be-impossible
  `synced_anomaly` case) plus pure unit tests in
  `test/auditUnsyncedActiveAppointments.test.js`.
- **A Phone Call is never an appointment.** Only a real Appointment / Site
  Visit is an `appointments` row. `bookingService` refuses a Phone Call
  (`422 phone_call_is_follow_up`, incl. rescheduling a legacy unbuffered Phone
  Call row); `PUT /leads/:id/appointment` with `appointment_type: 'Phone Call'`
  and public capture's Phone Call appointment are saved as the lead's Phone Call
  FOLLOW-UP instead (a legacy Phone Call booking on the lead is cancelled; a
  Site Visit is untouched), and a missing `appointment_type` on a lead with a
  legacy Phone Call row is a 400, never a silent Site Visit. The Appointment
  editor offers no Phone Call kind.
- **Follow-up calendar visibility = one non-blocking reminder, for EVERY
  follow-up type (PERMANENT RULE)** (one canonical classification:
  `lib/booking/phoneCallModel.js#isActiveFollowUpReminder`,
  `CALENDAR_REMINDER_FOLLOWUP_TYPES = FOLLOW_UP_TYPES`). This was originally
  Phone-Call-only; it was generalized to cover Phone Call, Meeting, Text,
  Email and Other identically after a production report
  (lead "Jamey Corey") showed a Meeting follow-up with no Google Calendar
  presence, which was then-current, documented, intentional behavior — not a
  bug — until this rule superseded it. The lead's active, timed follow-up
  (any type) is the ONLY source; the calendar worker reconciles it
  (`lib/booking/followUpReminders.js`, state in
  `followup_calendar_reminders`, including its `followup_kind` column) to
  exactly one Google event per lead — deterministic id (per lead +
  generation), `transparency: transparent`, private
  `ec_kind=followup_reminder`, `ec_blocking=false`, `ec_followup_kind`
  reflecting the actual type (e.g. `meeting`, `phone_call`), summary/
  description reflecting the actual type (e.g. `Meeting: <name>`), owner as
  the only attendee, no travel. Reschedule / reassignment / note edits /
  **retype** all update the SAME event in place (retyping while still active
  — e.g. Phone Call → Email — never removes it, only relabels it); completed
  / cleared / deleted removes it (a past one is kept as history). This stays
  fully independent of the Appointment (which remains busy/blocking, synced
  separately by `lib/booking/calendarOutbox.js`) — neither path ever
  overwrites, clears, moves or completes the other. Availability ignores the
  reminder by the private marker (`isNonBlockingCrmGoogleEvent`), never by
  title or Google free/busy alone; external Google events keep blocking.
  Legacy Phone Call appointment rows never get a main/travel event
  (`enqueueCreate/enqueueUpdate`, worker backstop,
  `reconcileSyncedAppointments`), their old Google events are dropped from
  availability by `ec_appointment_id` (`dropLegacyPhoneCallWindows`), and
  active future ones are moved onto the lead's follow-up by
  `lib/booking/legacyPhoneCallConversion.js` (backed up in
  `legacy_phone_call_conversions`; different active follow-up / closed lead →
  `ambiguous`, untouched; undo: `scripts/revertLegacyPhoneCallConversion.js`,
  report-only unless `APPLY=1`). Live aggregate proof (no PII, now
  type-agnostic though its JSON field names keep their original
  `phone_call_*` spelling for API stability): admin-only
  `GET /api/v1/system/phone-calls` (+ `/phone-calls/ambiguous`, read-only
  provenance of ambiguous rows) — `routes/systemHealth.js`; auth = CRM admin
  JWT or the website repo's private `final-verify.yml` GitHub OIDC identity
  (`lib/systemHealthAuth.js`). Real-Postgres coverage:
  `test/integration/phoneCallCalendarReminder.int.test.js` (including case N,
  the Meeting-type proof, and case H, the retype-keeps-the-event proof).
- **Driving / Travel Time** exists only for an ACTIVE Site Visit —
  `lib/booking/appointmentKind.js#travelAllowed`, checked in
  `calendarOutbox.enqueueCreate/enqueueUpdate` AND again by the worker before
  it creates/updates a queued travel event (`skipped: travel_not_allowed` /
  `stale_slot`). A successful `cancel_travel` clears
  `google_travel_event_id`; the travel event never sets the appointment's sync
  status. Historical invalid travel events: `scripts/auditTravelArtifacts.js`
  (report-only by default; `--apply --confirm-host` only queues `cancel_travel`
  for provably invalid UPCOMING artifacts). Real-Postgres coverage:
  `test/integration/phoneCallNeverAppointment.int.test.js`,
  `test/integration/auditTravelArtifacts.int.test.js`.
- **`qb_invoice_sale_map`**: `crm_sale_id` is the ONLY ownership boundary
  for a QuickBooks invoice, and a mapping is NEVER reassigned once created
  (`ON CONFLICT DO NOTHING`). Never resolve invoice ownership by amount,
  customer, or date.
- **Terminal-lost transition (PERMANENT RULE, production bug fix,
  generalized after a second production bug)**: the moment a lead's status
  changes TO any value in `lib/leadStatus.js#TERMINAL_LOST_STATUSES` (the
  actual edge, never re-fired on a later edit that merely leaves it there,
  and never re-fired when moving BETWEEN two terminal-lost statuses —
  `lib/leadStatus.js#isEnteringTerminalLostStatus`), from EVERY write path
  that can set `leads.status` (`routes/leads.js`'s `PUT /:id` and
  `PUT /by-external/:externalRef` — the only two; verified no other route
  writes this column), two things happen atomically with the status write
  itself: (1) the lead's follow-up is force-cleared (same `normalizeFollowUp({})`
  semantics as `PUT /:id/follow-up`'s own clear, including the two fields —
  `follow_up_notes`/`follow_up_status` — that aren't even in
  `UPDATABLE_FIELDS`/`CRM_FIELDS`), overriding anything the SAME request body
  tried to set; (2) post-commit (cannot run inside that transaction —
  `bookingService.cancelAppointment` owns its own transaction, audit row and
  durable Google Calendar outbox enqueue), every appointment still
  `'scheduled'`/`'confirmed'` for that lead — regardless of whether its start
  time is in the past (CLAUDE.md's own appointment-status rule: never infer
  "completed" from a past start time, only the row's own status decides) —
  is cancelled through the canonical `bookingService.cancelAppointment`,
  never a second/raw cancellation path. A genuinely `'completed'`/`'no_show'`/
  `'cancelled'`/`'rescheduled'` appointment is NEVER touched — no version
  bump, no calendar call, preserved exactly as history. Clearing the
  follow-up + cancelling the appointment together empty `reminder_leads`'s
  projection (`lib/reminderProjection.js#syncLeadToReminders`'s own
  `hasDates` check), which is the SAME table BOTH `lib/reminderEngine.js`
  (appointment reminders) and `lib/phoneCallReminders.js` (phone-call
  reminders) read via `lib/crmRepository.js#listEligibleLeads` — so this one
  mechanism silences every reminder engine with no per-engine special-casing,
  and `lib/booking/followUpReminders.js`'s own desired-state reconciliation
  (already covers "follow-up cleared" as one of its four removal triggers)
  removes the non-blocking follow-up calendar event with no code change of
  its own. Defense-in-depth beyond the primary fix (for leads that were
  ALREADY terminal-lost before this shipped, or any future projection-sync
  bug): `lib/crmRepository.js#listEligibleLeadsPostgresProd` LEFT JOINs back
  to `leads` and excludes every `TERMINAL_LOST_STATUSES` value directly
  (fails OPEN — keeps the row — when the join can't resolve a lead, same
  "never silently drop a real notification" philosophy as
  `lib/notificationPreferences.js`);
  `lib/booking/calendarOutbox.js#reconcileSyncedAppointments`'s `isLostDnq`
  guard now imports `isTerminalLostStatus` from the same shared module
  (rather than hardcoding its own separate status list), so a missing
  Google event is never recreated for any terminal-lost lead; `routes/
  cronJobs.js`'s `/notify-status-change` and `/send-project-status-email`
  (unused by any in-repo caller today, but a documented automation entry
  point) both read the lead's CURRENT `leads.status` fresh and skip sending
  if `isTerminalLostStatus(lead.status)`, never trusting a caller-supplied
  `old_status`/`new_status` param instead. Reopening a terminal-lost lead
  (status changes AWAY from every value in the set) is deliberately a no-op
  here — it NEVER auto-restores the cancelled appointment or the cleared
  follow-up; only an explicit new reschedule/follow-up afterward resumes
  normal reminder projection.

  **Root-cause correction (production bug, lead "Rita Wilcher")**: this
  rule originally (first shipped version) matched ONLY the literal string
  `'Closed Lost'`. That literal is unreachable through any live, current UI
  status control — it is absent from
  `crm-frontend/src/lib/design-system.js#STATUS_STYLES` (that file's own
  header calls it "the one canonical source" for status values),
  `LeadDetailModern.jsx`'s `STATUSES` dropdown, and `KanbanBoard.jsx`'s
  `STATUS_COLUMNS`. The status a user actually sets when a lead is dead is
  `'Lost'` — so the original fix never fired for the overwhelmingly common
  real-world case, which is exactly what happened to lead Rita Wilcher: her
  appointment was cancelled before the scheduled meeting and her lead was
  marked `'Lost'`, but the CRM calendar still showed the meeting and its
  Driving/Travel Time blocks, and the appointment card still offered
  Done/Reschedule, because none of this rule's logic had run. Fixed by
  generalizing `lib/leadStatus.js` from a single literal to
  `TERMINAL_LOST_STATUSES = ['Lost', 'Closed Lost', 'DNQ', 'Cancelled']`
  (matching pre-existing precedent already present elsewhere in this
  codebase treating these as equivalent: `MobileDayView.jsx`'s
  `excluded`/`excludedForOverdue` arrays, `LeadBreakdown.jsx`'s
  `'closed-lost'` bucket listing both `'Lost'` and `'Closed Lost'`,
  `scripts/reconcileGoogleContactsLive.js`'s exclusion list). Deliberately
  excludes `'Sold'`/`'Won'` (positive outcomes — a post-sale appointment can
  be legitimate), `'Duplicate'` (owned by the separate lead-merge subsystem),
  and `'Archived'`/`'Closed'` (not confirmed reachable via any live UI
  control today — tracked as an open item, not guessed into the set). The
  deprecated `isEnteringClosedLost`/`CLOSED_LOST_STATUS` names are kept as
  backward-compatible aliases (now backed by the generalized set) so no
  caller silently keeps missing the common case.

  **Historical backfill**: leads that were already in a terminal-lost status
  before this rule existed (or before it was generalized beyond the single
  `'Closed Lost'` literal) may still carry a stale active appointment and/or
  a stale follow-up that no live write path will ever revisit on its own.
  `scripts/remediateTerminalLostLeadAppointments.js` is the report-first
  (`--apply --confirm-host=<host>` to write), idempotent, re-runnable
  catch-up: it finds every lead whose current status is in
  `TERMINAL_LOST_STATUSES` that still has an active appointment and/or a set
  follow-up (an unconditional bug per this rule — never an ambiguous judgment
  call the way `scripts/auditAppointmentFollowUp.js`'s DIV_OTHER class is),
  and remediates each one through the exact same mechanism as the live
  transition handler (force-clear the follow-up + `syncLeadToReminders` in
  one transaction, then cancel every still-active appointment through
  `bookingService.cancelAppointment`, then one audit note). It has been
  unit/integration-tested against a disposable local Postgres but has NOT
  been run against the real production database from this environment (no
  production `DATABASE_URL`/network access here) — running it (report-only
  first, then `--apply` if warranted) against production is an operator
  action, not something this environment can execute.

  Real-Postgres coverage: `test/integration/closedLostTransition.int.test.js`
  (all 8 original scenarios for the literal `'Closed Lost'`, including a
  genuine already-firing reminder proven silenced and a simulated Google API
  failure proven left in the retry-eligible `'failed'` state rather than
  falsely marked synced, PLUS 3 added scenarios proving the generalized fix
  fires for the real-world `'Lost'` status, for `'DNQ'`/`'Cancelled'`, and
  that moving BETWEEN two terminal-lost statuses is not a fresh re-entry);
  `test/integration/remediateTerminalLostLeadAppointments.int.test.js` (the
  backfill script's report-only/`--apply`/idempotent-re-run behavior,
  including proof that a `'Sold'` lead and an already-`'completed'`
  appointment are never touched).
- **Reminders**: default to dry-run (`REMINDER_DRY_RUN` must be explicitly
  `'false'` to send real customer-facing email); the HTTP trigger route
  force-overrides to dry-run regardless of query params as a second safety
  net — do not remove that override. Reminder worker is currently **active
  in production with real sending enabled** — do not treat it as inert.
- **Lead ownership/visibility**: admin/manager see everything; `office`
  sees everything read-only; `sales_rep` is scoped via `routes/leads.js`'s
  `resolveOwnerScope` (FK join to `owners`, resolved from the caller's JWT
  email) — a rep with no matching `owners` row fails closed.
- **Twilio SMS messaging (two-way, customer-facing)**: `lib/smsClient.js`
  (raw Twilio REST, no SDK dependency, mirrors the fetch-based style already
  established by `lib/reminderAlerts.js`'s internal-alert SMS and
  `lib/systemHealthChecks.js#checkTwilio`'s health probe — the only two
  Twilio call sites that existed before this) + `lib/smsService.js` (the ONE
  place that decides whether a message is allowed to go out, matches an
  inbound message to a lead, and persists the two-way log) +
  `routes/sms.js` (`POST`/`GET /api/v1/leads/:id/sms`, `POST
  /api/v1/sms-webhook/{inbound,status}`). Reuses existing conventions rather
  than inventing new ones:
  - **Ownership/visibility**: `routes/sms.js` reuses `routes/leads.js`'s
    `resolveOwnerScope` (now exported for this purpose) — SMS
    send/visibility follows the exact same admin/manager/office/sales_rep
    rules as the lead itself, never a separate SMS-specific permission
    model.
  - **Module gate**: both the authenticated and webhook routes are gated on
    `enabled_modules.sms` (`lib/moduleGate.js`) — a pre-existing key in
    `company_settings`'s defaults that no customer-facing route read before
    this; a disabled installation's SMS routes 404 `module_disabled`, same
    as `meta`/`website_intake`.
  - **Consent (this phase, transactional-only)**: every outbound message
    built here — a Lead Detail compose, a future appointment/follow-up SMS
    — is transactional/service messaging, gated on the SAME
    `leads.sms_consent` column migration `2026-43-website-lead-intake.sql`
    already added. No new marketing-consent column exists yet; a genuine
    marketing-SMS capability needs its own consent column + disclosure
    copy, a deliberate future product decision, not built here. A lead's
    phone number existing is never treated as consent — `sms_consent` must
    be exactly `true`.
  - **Opt-out (STOP/START/HELP)**: `sms_opt_outs` is keyed by PHONE NUMBER,
    never by lead — a STOP is honored for that number forever, independent
    of which lead (if any) it is ever matched to, and is checked
    unconditionally before consent on every outbound send (an opted-out
    number is never messaged regardless of consent). Keyword detection
    (`lib/smsService.js#detectKeyword`) matches Twilio's own documented
    keyword lists (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT,
    START/YES/UNSTOP, HELP/INFO) on the WHOLE trimmed message only, never a
    substring — "please stop texting me" is an ordinary message, not a
    keyword. The webhook replies with TwiML identifying the company by name
    for STOP/START/HELP (never for an ordinary message — empty TwiML, no
    auto-reply) rather than firing a second outbound API call. This is one,
    independent layer — it never assumes Twilio's own Advanced Opt-Out
    (if enabled on the Messaging Service) is configured, and doesn't
    conflict with it either way.
  - **Phone matching**: inbound numbers are matched against `leads.phone`
    using `lib/captureValidation.js#normalizePhone` (bare last-10-digits) —
    the SAME tolerant comparison the public-capture/booking intake path
    already uses (see the phone-matching split documented under "Database
    safety" above: the admin path is exact `+1XXXXXXXXXX`, the
    capture-style path is bare-last-10). An inbound webhook is exactly the
    capture-style case (an external, unauthenticated number with no
    formatting guarantee), so that is the one reused here — never a third
    implementation. Zero or multiple matching leads is never resolved by
    guessing: zero → `lead_id` NULL; multiple → `lead_id` NULL,
    `ambiguous_match=true`, `candidate_lead_ids` populated for manual
    review — the message is still stored either way, never silently
    dropped.
  - **Quiet hours**: outbound sends are blocked outside 8:00–21:00 (the
    installation's configured timezone, `companyConfig.getTimezone()`,
    default `America/Los_Angeles`; window configurable via
    `SMS_QUIET_HOURS_START`/`SMS_QUIET_HOURS_END`). Applies to the outbound
    send path only — inbound keyword processing (STOP/START/HELP) always
    runs regardless of time.
  - **Idempotency/retries**: inbound messages are deduplicated on Twilio's
    `MessageSid` (`sms_messages.twilio_sid` UNIQUE) — a redelivered webhook
    never creates a second row or double-processes a keyword. Outbound
    sends get one bounded immediate retry on a transport failure (network/
    config error), never a retry loop; a genuine Twilio-side rejection
    (4xx) is recorded as `failed` and surfaced to the rep, not retried
    silently. Delivery status (`sent`/`delivered`/`failed`/`undelivered`)
    is updated via `POST /api/v1/sms-webhook/status` keyed on the same
    `twilio_sid` — a callback for an unrecognized sid is a no-op, never an
    error (an out-of-order/duplicate callback is not a problem).
  - **Webhook signature verification**: `lib/smsClient.js#verifyTwilioSignature`
    implements Twilio's documented `X-Twilio-Signature` algorithm
    (HMAC-SHA1 over the exact webhook URL + sorted POST params). Skips
    verification (returns true) when `TWILIO_AUTH_TOKEN` is unset, matching
    `routes/metaWebhook.js#verifyMetaSignature`'s existing "not configured →
    skip" convention.
  - **Not yet verified from this environment** (no outbound network access,
    no Railway/Twilio Console access): whether `TWILIO_ACCOUNT_SID`/
    `TWILIO_AUTH_TOKEN`/a sender identifier are actually set in Railway
    production, whether the approved A2P Campaign is associated with the
    right Messaging Service/sender number in the Twilio Console, and
    whether a real send/receive round-trip succeeds end-to-end against a
    live number. Do not treat production SMS as operational until all
    three are confirmed. Real-Postgres coverage (fake Twilio client, no
    live network call): `test/integration/sms.int.test.js`; pure unit
    coverage: `test/smsService.test.js`, `test/smsClient.test.js`.
- **Base44 is retired from the production path.** Known, now-fixed
  exceptions found and corrected in this session: `lib/reminderEmails.js`
  and `lib/reminderPages.js` previously hardcoded a live
  `media.base44.com` logo URL in customer-facing reminder emails and action
  pages (fixed to serve from `${CRM_PUBLIC_URL}/email-logo.png`, matching
  `lib/emailTemplates.js`'s existing pattern); `lib/actionRouter.js`'s CSP
  `img-src` was updated to match. `test/noBase44MediaDependency.test.js` is
  a permanent regression guard against this class of issue recurring. No
  known exception remains: the last Base44-calling code (the migration
  scripts, the `system-wide-reconciliation` endpoint, the stale `src/`
  tree and the frontend's `lib/app-params.js`, which parsed a Base44
  `access_token`/`app_id` from the URL into `base44_*` localStorage keys on
  every page load) was removed.

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

## Handoff → QuickBooks → CRM estimate sync (production architecture, confirmed October 2026)

EC Construction Group does **not** have a Handoff API key and is **not**
pursuing a direct Handoff API connection — `lib/handoffClient.js`'s
`getApiKey()`/`checkHandoff()` correctly report Not Configured for that,
and this is expected, not a defect. The real, actively-used pipeline is
**Handoff → QuickBooks → CRM**: Handoff pushes its own estimates directly
into QuickBooks (visible in QB as `CustomerRef`/`DocNumber` values prefixed
`HNDF-PRJ-...`/`HNDF-EST-...`), and this CRM discovers and ingests them
independently:
- **`server.js`'s QB Estimate Sync cron** (`runQbEstimateSync`, every 15
  minutes, unconditional unless `QB_SYNC_CRON_ENABLED=false`) fetches every
  QB `Estimate`, matches each to a CRM lead via `lib/qbMatch.js`, and
  upserts into `handoff_estimates` with `sync_source = 'QuickBooks'`. A
  companion cron tick (`runQbEstimatePdfSync`) fetches each matched
  estimate's PDF (bounded retry, 5 attempts). Progress is recorded in
  `sync_cursors` (`integration = 'quickbooks_estimates'`).
- **`routes/leadQB.js`'s `POST /by-external/:externalRef/sync-estimates`**
  is the lead-scoped manual equivalent (admin/manager only) — same matching
  engine, same `handoff_estimates` target, includes sub-customer and
  full-QB-estimate-scan fallbacks. Verified (`test/estimateSyncRestoration.test.js`):
  has zero dependency on the Handoff API/`HANDOFF_API_KEY`.
- **`routes/handoffEstimates.js`** (`/api/v1/handoff-estimates`) is pure
  CRUD over the `handoff_estimates` table the above two populate — it has
  no sync logic of its own.
- **Existing admin UI already surfaces this pipeline's real state** without
  needing DB/log access: `EstimateSyncDiagnostics.jsx` (per-estimate
  Handoff→QB→CRM status, match method) and `UnmatchedEstimatesPanel.jsx`
  (manual lead-linking for anything the automatic matcher couldn't
  resolve), both on the Integrations page.

**Two confirmed defects found and fixed in this pass (October 2026 audit),
both in the matching/dedup logic above, neither related to the unused
direct Handoff API:**

1. **`lib/qbMatch.js#findMatchingLead` — ambiguous phone+name / email+name
   matches silently guessed `hits[0]`.** Priority 1 (phone + partial name)
   and Priority 2 (email + partial name) picked the first lead in
   `-created_date` order when more than one lead shared the same phone (or
   email) AND partially matched the same name fragment — e.g. two
   independently-created leads for the same household, or an unmerged
   duplicate — rather than declining to guess the way Priority 0 (the
   authoritative `qb_customer_id` mapping) already correctly does. A real
   QuickBooks estimate could silently attach to the wrong lead with no
   record anything was ambiguous. Fixed: an ambiguous Priority 1/2 result
   now falls through to the next, different-signal priority (it is a
   heuristic, not authoritative, so unlike Priority 0 it should keep trying
   other signals rather than failing the whole lookup closed). Regression
   coverage: `test/qbMatch.test.js`.
2. **`server.js#runQbEstimateSync` loaded its matching/dedup sets through a
   hard `rda.list(..., limit, 0)` cap** — 2000 leads, 1000 existing
   `handoff_estimates` rows, both ordered newest-first. Past either cap,
   the oldest rows silently drop out of memory for that run: a lead past
   the 2000 cutoff can never be matched against a new QB estimate, and a
   `handoff_estimates` row past the 1000 cutoff is no longer found by the
   `existingEstimates.find(qb_estimate_id)` de-dup check, so the next tick
   re-inserts it as a **duplicate row** instead of updating it — directly
   contradicting this function's own documented idempotency invariant.
   Current production row counts were not checked from this environment
   (no DB access), so whether this has already manifested is unconfirmed —
   but the caps were unconditional and scale only one direction. **Follow-up
   pass (same audit, second review before merge)**: the `leads` cap was kept
   (raised to 50000 — it feeds `qbMatch.js`'s in-memory fuzzy matching
   engine, which genuinely needs a candidate set, not a single lookup; 50000
   is far beyond any realistic row count for this one-company-per-deployment
   install), but the `existingEstimates` dedup was changed from a bulk
   `rda.list` preload to a direct, indexed per-estimate query
   (`rda.filter('HandoffEstimate', { qb_estimate_id })`, backed by the
   existing `idx_handoff_estimates_qb_id` index) — this removes the cap
   dependency for duplicate prevention entirely; it is correct regardless of
   how large `handoff_estimates` ever grows. A pre-existing duplicate (>1
   row already sharing a `qb_estimate_id`, from before this fix) is now
   surfaced via a warning log rather than silently resolved either way.
   Regression coverage (source-level, since exercising the live cron needs a
   real QB connection): `test/qbEstimateSyncCapacity.test.js`.
3. **`runQbEstimateSync` had no re-entrancy guard.** A run overlapping
   itself (slower than the 15-minute cron interval, or racing a manually
   triggered `POST /sync/qb-estimates` job) could have two concurrent passes
   both see the same QB estimate as "not yet in `handoff_estimates`" and
   both `INSERT` — a duplicate. Fixed with the same `_syncing`-style
   boolean guard already used in `lib/qbInboundSync.js`
   (`_estimateSyncRunning`); an overlapping call returns
   `{ skipped: true, reason: 'already_in_progress' }` instead of racing.
4. **The automatic matcher silently overwrote human-confirmed manual
   matches.** Every automatic re-match write (both the "matched" and
   "unmatched" branches) unconditionally overwrote `lead_id`/`match_status`/
   `match_method` on any existing row whenever QuickBooks'
   `MetaData.LastUpdatedTime` advanced — including a row a human had just
   corrected via `UnmatchedEstimatesPanel.jsx`'s "Save & Link"
   (`match_method: 'manual'`). The next time Handoff touched that estimate
   in QuickBooks (e.g. an amount or status change), the cron would silently
   revert the human's correction — potentially re-attaching the estimate to
   a *different* lead, or back to unmatched, with no trace. Fixed: a new
   `isManuallyMatched(existing)` guard (`server.js`) is checked FIRST, before
   `qbMatch.findMatchingLead` is even called — a manually-matched row only
   has its non-matching business fields (amount/status/date/etc.) refreshed;
   `lead_id`/`match_status`/`match_method` are left exactly as the human set
   them, for as long as that row stays manually matched. Regression
   coverage: `test/qbEstimateSyncManualMatch.test.js` (pure unit, the
   extracted guard function) + `test/qbEstimateSyncCapacity.test.js`
   (source-level proof it runs before automatic re-matching).

**System Health now distinguishes the two Handoff-adjacent things that were
previously conflated under one "Handoff" card**
(`lib/systemHealthChecks.js#checkHandoffEstimatesSync`,
`crm-frontend/src/pages/SystemHealth.jsx`): "Handoff (Direct API)" —
unchanged, correctly Not Configured — and new "Handoff Estimates (via
QuickBooks)", which reports the sync pipeline's own real evidence
(`sync_cursors.quickbooks_estimates.last_successful_sync_at`,
`handoff_estimates` matched/unmatched counts) completely independent of the
unused Handoff API credential. Flagged stale if the last successful cron
run was over an hour ago (the cron runs every 15 minutes). No new
`company_settings.enabled_modules` key was added — it rides on no toggle of
its own (`MODULE_FLAG_ENFORCED.handoff_estimates_sync = false`, same
precedent as `sms`), so it is never forced to DISABLED.

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
bridge. Base44-referencing comments and legacy column names (e.g.
`legacy_base44_id`, `base44_entity_map`) document what was replaced or keep
historical data readable; they are not live integration points.
