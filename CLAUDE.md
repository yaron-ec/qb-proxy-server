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
| Twilio SMS (two-way, customer-facing) | `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + `TWILIO_MESSAGING_SERVICE_SID` (A2P, preferred) or `TWILIO_FROM` (bare number) — the SAME env vars `lib/reminderAlerts.js`'s internal staff-alert SMS and `lib/systemHealthChecks.js#checkTwilio`'s health probe already used before this — **PLUS `TWILIO_WEBHOOK_BASE_URL`** (the `qb-proxy-server` backend's own public URL — never `CRM_PUBLIC_URL`, the frontend's URL; see the October 2026 inbound-webhook incident below) for inbound signature verification and the outbound status-callback URL | `sms_messages` (two-way log), `sms_opt_outs` (phone-level STOP/START registry), `sms_webhook_rejections` (rejected-webhook diagnostics) | Env-var gated (`sms` module in `enabled_modules` — pre-existing key, previously unused by any customer-facing route) |

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
     — gates ONLY the inbound-reply EMAIL side effects (`notifyAssignedRep`/
     `notifyUnmatchedForReview`).
  Gates 2 and 3 were originally the SAME switch; split apart (October 2026,
  live-SMS end-to-end verification pass) because that coupling made it
  impossible to live-test an inbound reply's rep-notify behavior without
  simultaneously arming real confirmation/reminder sends for every live
  upcoming appointment — exactly the accidental blast-radius this gate
  philosophy exists to prevent. Each surface now has its own explicit
  opt-in; turning one on never turns the other on
  (`test/smsReplyNotify.test.js`'s "decoupled gate" test is the permanent
  regression guard against re-coupling them). This exists specifically so
  deploying this code can never itself start automated customer sends just
  because `sms` was already on for manual messaging — an operator must take
  a deliberate additional step per surface they want active. Mirrors
  `REMINDER_DRY_RUN`'s existing safe-by-default precedent. Gate 1 plus the
  relevant one of gate 2/3 must both be true for a given surface to send.
- **Two-way replies**: reuses the EXISTING inbound webhook
  (`routes/sms.js`, `lib/smsService.js#handleInboundMessage`) completely
  unchanged for matching/consent/opt-out/dedup. One EMAIL side effect fires
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
    category/migration needed). This is also how Yaron is notified of an
    unmatched/ambiguous reply when he is a configured staff recipient with
    that category enabled — by email, like every other staff member, never
    by a personal SMS copy.
  - **RETIRED (November 2026, revised notification-design decision):** a
    prior `forwardToYaronBestEffort` function forwarded every ordinary
    inbound reply as a SEPARATE outbound Twilio SMS to a
    `SMS_REPLY_FORWARD_TO`-configured destination, in addition to the email
    above. This has been REMOVED (both the function and its call site in
    `routes/sms.js`) — inbound-reply notifications now go exclusively
    through the EMAIL path above, the same mechanism every other
    lead-related CRM notification already uses. Yaron is notified like any
    other staff member: by email, as the lead's assigned owner
    (`notifyAssignedRep`) or via the staff `ACTIVITY` broadcast
    (`notifyUnmatchedForReview`) — never via a second paid outbound SMS to
    his personal phone. `SMS_REPLY_FORWARD_TO` must stay unset in
    production; nothing in this codebase reads it anymore, and a stray
    value left in the environment is provably never read (see
    `test/systemHealthChecks.test.js`'s "stray `SMS_REPLY_FORWARD_TO`"
    test).
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

## CRM New Lead intake SMS consent (Philippines appointment-setting reps, October 2026)

A representative-reported consent checkbox in the CRM New Lead intake form
(`crm-frontend/src/pages/LeadCapture.jsx`, served at `/capture` — this is
the SAME component used both for the truly public website embed AND, via
`?returnToCRM=true` from the "New Lead" button in `LeadsModern.jsx`, as the
authenticated internal New Lead form the Philippines appointment-setting
team actually uses; "New Lead intake form" always means this one form, not
a separate internal-only component), feeding the SAME `leads.sms_consent`
gate the rest of the automated-SMS surface already checks — no second
consent flag, no parallel mechanism.

- **Checkbox**: "I confirmed with the customer that they agree to receive
  SMS appointment confirmations, reminders, and appointment-related
  messages from EC Construction Group." Unchecked by default. Rendered
  ONLY when an appointment is actually being booked in that same
  submission (inside the existing "Appointment / Site Visit" step, right
  below the time slot picker) — a representative's rep script
  (`crm-frontend/src/lib/smsConsentScript.js`, the ONE place this wording
  lives) is shown above it covering company identity, purpose, frequency,
  message/data-rates, and STOP/HELP, to be read to the customer before
  checking the box. Leaving it unchecked still saves the lead and
  appointment normally — it only withholds consent, same as before this
  feature existed.
- **Server-side mirror of "only with an appointment"**:
  `lib/captureValidation.js#validateCapturePayload`'s `sms_consent_confirmed`
  is forced `false` whenever `appointment_date`/`appointment_time` are
  absent from that submission — a checked box on a lead-only capture (no
  appointment this time) is explicitly ignored, never silently carried
  over to some future appointment. A Phone Call "appointment" (rewritten to
  the lead's Phone Call follow-up before this point — see "A Phone Call is
  never an appointment" below) never carries consent through either, so
  automated appointment SMS structurally can only ever apply to a genuine
  in-person appointment — this was ALREADY true architecturally before this
  feature (the booking-confirmation SMS only ever fires when
  `bookingService.createBooking()` returns a real `appointment` row, and a
  Phone Call never produces one), so no new "is this in-person" check was
  needed to satisfy that requirement.
- **Race-free persistence (the real design problem this feature solves)**:
  `lib/smsConsentIntake.js#applyAppointmentSmsConsent` is called from INSIDE
  `bookingService.createBooking()`'s open transaction, immediately before
  `COMMIT` — never from a post-commit step. The booking-confirmation SMS
  (`sendBookingConfirmationSmsBestEffort`) reads `sms_consent` off the
  SAME already-committed lead row `createBooking()` returns; writing
  consent any later (e.g. a follow-up `UPDATE` in `routes/publicCapture.js`
  after `createBooking()` resolves, which is where the post-commit
  "extra capture fields" update already lives) would race that read and
  lose almost every time, defeating the entire feature for a brand-new
  lead's first appointment. `routes/publicCapture.js` passes
  `sms_consent_confirmed` + `sms_consent_recorded_by` (the validated
  `owner_email`, resolved from `assigned_rep` the same way every other
  identity on this public, unauthenticated endpoint already is — see
  "Database safety" below for why no stronger identity exists on this
  specific route today) straight through as `createBooking()` input fields.
- **STOP opt-out is NEVER overridden, by intake OR by a later manual
  change**: `lib/smsConsentIntake.js`'s `isPhoneOptedOut` guard (checked
  against `sms_opt_outs`, the SAME phone-keyed, forever registry
  `lib/smsService.js#sendSms` already enforces) runs before EVERY grant of
  `sms_consent = true` — an opted-out number's consent request is declined,
  with an `activities` audit note explaining why, never silently granted
  and never silently dropped. Revoking consent is always allowed (it can
  only reduce what gets sent) and never needs the opt-out check.
- **Audit trail**: every consent grant/decline/revoke writes one
  `activities` row (visible in Lead Detail's existing activity feed, no new
  UI needed for this part) PLUS the structured columns
  `leads.sms_consent_at` / `sms_consent_source` / `sms_consent_disclosure_version`
  (all pre-existing, from `2026-43-website-lead-intake.sql`) and the one
  new column, `leads.sms_consent_recorded_by`
  (`2026-64-sms-consent-intake.sql`) — WHO reported or recorded it. Phone
  intake's `sms_consent_source` is the literal string
  `'phone call — Philippines intake representative'`.
- **Visible in Lead Detail + a later authorized change**:
  `routes/leads.js#serializeLead` was previously missing EVERY
  `sms_consent*` field entirely — found while building this feature.
  `crm-frontend/src/components/SmsPanel.jsx`'s existing "No SMS consent on
  file" banner (and the compose box's `no_consent` rejection) were both
  already correctly wired to `lead.sms_consent`, but since that field never
  actually reached the frontend, the banner showed REGARDLESS of the real
  stored value — a real, if narrow, display bug (sending was still
  correctly gated server-side by `lib/smsService.js#sendSms`'s own fresh DB
  read; only the Lead Detail DISPLAY was wrong). Fixed by adding
  `sms_consent` / `sms_consent_at` / `sms_consent_source` /
  `sms_consent_recorded_by` to the serializer. `SmsPanel.jsx` now also shows
  those details when consent is on file and offers an authorized
  grant/revoke action (`PUT /api/v1/leads/:id/sms-consent`, reusing the
  SAME `resolveOwnerScope` ownership authorization as every other lead
  write — never a separate permission model) that records
  `sms_consent_recorded_by` as the AUTHENTICATED caller's own email (a
  stronger identity signal than phone intake's self-reported
  `assigned_rep`, since this route requires a real Railway JWT) plus an
  optional free-text evidence note, going through the SAME opt-out guard on
  grant. A 409 `recipient_opted_out` is returned rather than silently
  succeeding or silently failing when the number has replied STOP.
- Regression coverage: `test/smsConsentIntake.test.js` (the opt-out guard
  and both call sites, fake queryFn, no DB), `test/captureValidation.unit.test.js`
  (the "only with an appointment in this submission" rule, including the
  Phone Call case); real-Postgres: `test/integration/smsAppointmentLifecycle.int.test.js`
  (proves the pre-commit ordering actually prevents the race against the
  real `createBooking()` path) and `test/integration/smsConsentIntake.int.test.js`
  (the real HTTP `POST /api/public/capture` path end to end, and the full
  `PUT /:id/sms-consent` grant/opt-out-refusal/revoke/visibility surface).

## SMS as a first-class activity in Lead Detail (October 2026)

Text Message is now a tab in the central activity composer
(`crm-frontend/src/components/ActivityComposer.jsx`): Note | Call | Email |
**Text Message** | Task | Meeting — matching the design and tab-switching
behavior of the other five, but rendering
`crm-frontend/src/components/SmsConversationPanel.jsx` instead of the
generic "fill a form, click Save" pattern (SMS has its own inline
compose/send, so the shared footer Save button is hidden for this tab
only). This REPLACED a separate left-sidebar `SmsPanel.jsx`, now deleted —
there is exactly one SMS UI in Lead Detail.

- **No backend change was needed for this.** Every requirement here (STOP
  opt-out, consent, quiet hours, delivery-status tracking, webhook dedup on
  `twilio_sid`, rep notification, the `SMS_AUTOMATED_REMINDERS_ENABLED` /
  `SMS_REPLY_NOTIFICATIONS_ENABLED` gates) already existed from the prior
  SMS work (see "Automated appointment SMS" above and "Twilio SMS
  messaging" below) — this pass is a frontend integration of
  already-correct, already-tested backend behavior into one consistent
  UI, not a new mechanism. (Note: at the time this pass was written, rep
  notification was accompanied by a now-retired SMS-to-Yaron forward — see
  "SMS reply-notification visibility..." below for its October 2026
  introduction and its November 2026 retirement.)
- **Timeline merge, not a second storage mechanism**:
  `crm-frontend/src/lib/smsActivityAdapter.js#smsMessageToActivity` reshapes
  a raw `sms_messages` row (from the EXISTING `GET /api/v1/leads/:id/sms`)
  into an activity-shaped object (`type: 'sms'`, id prefixed `sms-` so it
  can never collide with or be mistaken for a real `activities.id`) for
  display in the SAME chronological feed Notes/Calls/Emails/Tasks/Meetings
  already render through. `pages/LeadDetailModern.jsx` fetches this
  separately and merges it into the `activities` array by id — the EXACT
  same pattern already used for Gmail correspondence (a `Map`-keyed merge,
  not a naive concat) — and polls it every 15s so an inbound customer reply
  or a delivery-status transition on an already-sent message appears
  without a manual page refresh (this codebase has no push/websocket
  channel to the frontend; polling is the smallest change that satisfies
  that requirement without inventing new server infrastructure).
  `sms_messages` stays the ONE source of truth — nothing here ever writes a
  mirror row into `activities`. A **new "Text Messages" filter** was added
  to the existing activity-filter-tab row, consistent with the other
  filters. `ActivityCard` (in `LeadDetailModern.jsx`) renders the `sms`
  type with its own label/color, a Sent/Received badge, a delivery-status
  badge (queued/sent/delivered/failed/undelivered) for outbound messages,
  the error message/code when one failed, the detected STOP/START/HELP
  keyword when present, and the real sender/recipient identity via
  `smsAuthorLabel` (a rep's email for a manual send,
  `'system:booking_confirmation'` / `'system:reminder_12h'` /
  `'system:reminder_2h'` (+ `_deferred`) rendered as a friendly "Automated —
  ..." label, or "Customer" for an inbound reply) — **never editable or
  deletable** through the generic activity edit/delete affordance (it is a
  read-through of `sms_messages`, not a real `activities` row; `canEdit`
  explicitly excludes `activity.type === 'sms'`).
- **Consent status and the PR #40 control, now inside the Text Message
  tab**: `SmsConversationPanel.jsx` shows the same consent banner (on file —
  date/source/recorded-by — or missing, with an explanation) and the same
  authorized grant/revoke control (`PUT /api/v1/leads/:id/sms-consent`) that
  PR #40 built — moved here verbatim from the old sidebar panel, not
  rebuilt. The STOP opt-out guard on granting consent is unchanged.
- **The retry-status limitation that already existed is unchanged, not
  newly introduced**: `sms_messages` has no retry-count column — an
  outbound send gets one bounded immediate retry at send time (never
  persisted as a counter), and the 12h/2h reminder's quiet-hours retry
  happens at the `reminder_claims` table level, not per-message. What's
  shown here (status + error_message/error_code) is everything the schema
  actually records; "retry status" beyond that isn't a real, stored fact to
  surface.
- **Windows "Text" shortcut disambiguation** (`ContactActions.jsx`): the
  existing `href="sms:"` button opens the DEVICE's own native messaging app
  (iOS/Android Messages, or Windows' own "Text"/Phone Link handoff on
  desktop) — a message sent that way is never logged, never consent/opt-
  out-checked, and never appears anywhere in the CRM. Its tooltip now says
  so explicitly and points at the Text Message tab for the real,
  CRM-tracked alternative, so the two are never confused for the same
  feature.
- Regression coverage: `crm-frontend/src/lib/smsActivityAdapter.test.js`
  (the pure transform/author-label logic), `crm-frontend/src/pages/
  LeadDetailModern.smsActivity.test.jsx` (ActivityCard's sms rendering,
  including the never-editable guarantee),
  `crm-frontend/src/pages/LeadDetailModern.smsIntegration.test.jsx`
  (source-level horizontal audit — the merge/poll/filter-tab wiring and the
  sidebar panel's removal, matching this file's existing
  `invalidIdFix.test.jsx` convention for a page this large),
  `crm-frontend/src/components/ActivityComposer.sms.test.jsx` (the new tab
  end to end: compose/send, the consent banner/control, tab ordering),
  `crm-frontend/src/components/SmsConversationPanel.test.jsx` (the
  conversation view in isolation), `crm-frontend/src/components/
  ContactActions.test.jsx` (the disambiguating tooltip). No backend test
  changes — no backend code changed.

## SMS `sms_messages_status_check` production incident (October 2026, fixed)

A real manual SMS send from Lead Detail (test recipient: Michelle Roitman's
existing test lead, SMS consent already on file — NOT a consent/quiet-hours
issue) failed with:
```
new row for relation "sms_messages" violates check constraint
"sms_messages_status_check"
```
**Root cause**: `2026-63-sms-messaging.sql`'s original
`sms_messages_status_check` only allowed `('queued','sent','delivered',
'failed','undelivered','received')`. `lib/smsClient.js#sendMessage` returns
Twilio's own Message-create response `status` field verbatim
(`status: data.status || 'queued'`), and `lib/smsService.js#handleStatusCallback`
writes Twilio's StatusCallback `MessageStatus` verbatim too — the ONLY two
write paths for this column (every outbound send — manual compose, booking
confirmation, 12h/2h reminders — funnels through
`smsService.sendSms`; every delivery-status update funnels through
`handleStatusCallback`). This installation sends via
`TWILIO_MESSAGING_SERVICE_SID` (A2P — CLAUDE.md's own documented preferred
config), and Twilio's documented behavior for a Messaging-Service-originated
send is that the initial response status is `'accepted'` (Twilio hasn't
picked a Sender from the pool yet) rather than `'queued'` (the bare-From-number
initial state) — followed by a `'sending'` StatusCallback as the message
moves toward the carrier. Both are real, officially documented Twilio Message
statuses, reproduced directly against a migrated disposable Postgres
instance (both an `INSERT` with `status='accepted'` and an `UPDATE` to
`status='sending'` raised exactly the reported error) — this was never a
guess.

**Fix** (`db/migrations/2026-65-sms-messages-status-check-widen.sql`,
forward-only, additive, no data rewrite): widened the allow-list to the
complete, audited set of statuses this integration can legitimately receive
for plain, two-way, single-recipient SMS/MMS — `accepted, queued, sending,
sent, delivered, undelivered, failed, canceled, receiving, received`.
Deliberately excludes `'read'` (WhatsApp/channel read-receipts — structurally
impossible for plain SMS), `'partially_delivered'` (multi-recipient broadcast
only — this integration always sends to exactly one `To`), and `'scheduled'`
(Twilio's Schedule Send feature — `smsClient.js` never sets `SendAt`).
`lib/smsService.js#KNOWN_SMS_STATUSES` is the single source of truth mirrored
by the migration's CHECK list — `test/integration/sms.int.test.js`'s drift
guard queries the live `pg_constraint` definition and asserts it matches this
constant exactly, so the two can never silently diverge again.

**Defense in depth beyond the constraint** (`lib/smsService.js#normalizeSmsStatus`):
a FUTURE Twilio status this integration hasn't seen (a new value Twilio adds)
never hits the DB constraint again — `sendSms`'s INSERT falls back to
`'queued'` and logs a warning; `handleStatusCallback`'s UPDATE leaves the
row's existing status unchanged (no safe value to guess for an in-flight
message) while still recording the error fields, and logs a warning. Neither
path silently corrupts data; both are logged for investigation.

**Error handling fix** (`routes/sms.js`): both `/leads/:id/sms` routes'
catch-all blocks previously responded with `{ error: e.message }` for ANY
unexpected failure — for a Postgres driver error, `e.message` IS the literal
server-side message (this incident's own exact text). Never acceptable for a
customer-facing-adjacent CRM UI. Fixed via `logAndRespondUnexpectedError()`:
full detail (message, code, stack) goes to `console.error` only; the client
gets one generic, actionable message (`error: 'unexpected_error'`). This
exact raw-`e.message`-to-client pattern is known to still exist elsewhere in
this codebase (`routes/mergeLeads.js`, `routes/saleInvoices.js`,
`routes/companySettings.js`, `routes/invoices.js`, `routes/leadQB.js`, and
others) — tracked, pre-existing technical debt, NOT fixed here (this pass is
scoped to the SMS incident; a repo-wide error-handling pass is a separate,
deliberate change). Frontend: `crm-frontend/src/components/
SmsConversationPanel.jsx`'s `ERROR_LABELS` and `STATUS_BADGE` maps, and
`LeadDetailModern.jsx`'s `SMS_STATUS_LABEL` map, were both missing the new
statuses (and the new `unexpected_error` code) — updated so none of them
render as unstyled/raw text.

Regression coverage: `test/smsService.test.js` (pure unit —
`KNOWN_SMS_STATUSES`/`normalizeSmsStatus`, including the deliberate
exclusions); real-Postgres `test/integration/sms.int.test.js` — reproduces
the exact failure (`status='accepted'` on send, `status='sending'` on a
callback) against the real constraint BEFORE this migration is applied, and
proves both succeed after; also proves the defense-in-depth fallback for an
unrecognized status, the live-constraint-vs-code drift guard, and that
`/leads/:id/sms`'s two routes never leak a raw Postgres error (a malformed-id
DB error) to the response body.

## SMS inbound-webhook / status-callback production incident (October 2026, fixed)

A real controlled test (outbound SMS from the Text Message tab to Michelle
Roitman's test lead, `+13239611116`, successfully received) proved outbound
sending works — but her reply ("Hi") to the Twilio sender (`+18185930874`)
never appeared in the lead's conversation. Consent was already on file; this
was never a consent/quiet-hours issue.

**Root cause (confirmed via code audit, not guessed)**: `routes/sms.js`'s
webhook-signature-verification URL (and the outbound `statusCallbackUrl` it
supplies to Twilio on every send) was built from `CRM_PUBLIC_URL`. Every
OTHER call site of `CRM_PUBLIC_URL` in this codebase —
`lib/dataAccessRailway.js`, `lib/emailTemplates.js`, and conclusively
`lib/platformInfraProvisioning.js`'s own provisioning step, which sets
`CRM_PUBLIC_URL: frontendUrl` (never `backendUrl`) on the API service —
establishes it as the **FRONTEND's** own public URL
(`crm.ecconstructiongroup.com`), never the **backend**'s. Twilio signs its
webhook requests (and is given the status-callback URL) against the
BACKEND's real public URL — the only service actually running this Express
app — so verifying against `CRM_PUBLIC_URL` computed a URL that could never
match Twilio's real signature, unconditionally, for every single inbound
message and every delivery-status callback, regardless of how Twilio
Console was configured. Reproduced directly: a signature Twilio computes
against the real backend URL never verifies against the frontend's URL, and
does verify once computed against the correct one (see
`test/smsClient.test.js`'s "the incident, reproduced" test). Notably,
`lib/smsClient.js#verifyTwilioSignature`'s OWN prior header comment already
named a `TWILIO_WEBHOOK_BASE_URL` env var as the intended source — it was
simply never implemented; `routes/sms.js` read only `CRM_PUBLIC_URL`.

**Fix**: `webhookBaseUrl()`/`webhookBaseUrlSource()` moved into
`lib/smsClient.js` (the natural home given the above comment) and now read
the dedicated `TWILIO_WEBHOOK_BASE_URL` env var FIRST — this MUST be set to
the `qb-proxy-server` backend service's own public Railway domain (or custom
domain), never the frontend's. `CRM_PUBLIC_URL` remains only as a
last-resort fallback for graceful degradation (never worse than the
pre-fix bug) — never silently relied upon; see the System Health addition
below. **Operator action required**: set `TWILIO_WEBHOOK_BASE_URL` on the
`qb-proxy-server` Railway service, then confirm in Twilio Console that the
Messaging Service's "Incoming Messages" webhook URL (and, if a bare number
is used instead, the phone number's own messaging webhook) is set to
`<that backend URL>/api/v1/sms-webhook/inbound` — the exact, copy-pasteable
value now shown in System Health (see below). This same fix resolves BOTH
symptoms at once: inbound replies never processed, AND outbound
delivery-status callbacks (pending/sent → delivered) never arriving, since
both were broken by the identical URL mismatch.

**New observability, closing a real gap** (this codebase had ZERO queryable
evidence of a rejected webhook attempt before this — only a bare
`console.warn` line, requiring raw Railway log access to ever notice):
- `db/migrations/2026-66-sms-webhook-rejections.sql` — a new
  `sms_webhook_rejections` table (mirrors
  `2026-58-website-lead-intake-rejections.sql`'s established pattern for an
  inbound-webhook-only integration) recording every signature-verification
  failure on EITHER webhook route (`inbound` and `status`), with the EXACT
  URL our server expected Twilio to have signed against — directly
  comparable, character for character, to Twilio Console's configured
  webhook URL — plus the request's `Host` header, whether an
  `X-Twilio-Signature` header was present at all, and the best-effort
  `MessageSid`/`From` extracted from the still-parseable form body (Twilio's
  POST body parses fine even when the signature doesn't verify). Never the
  computed/expected signature value itself, never the auth token.
  `lib/smsService.js#recordWebhookRejection` is the write path, called from
  both `routes/sms.js` webhook handlers right before the 401 response;
  `lib/smsService.js#getInboundWebhookHealth` is the read path (inbound
  recency + rejection counts).
- `lib/systemHealthChecks.js#checkTwilio` now reports, independent of
  outbound-send credential presence (DB-only, mirrors
  `checkWebsiteIntake`'s established pattern): `recency` (last inbound SMS
  ever received + total), `delivery_failures` (rejected attempts in the
  last 24h / total / last rejected at), and a new `webhook_config` block —
  `base_url_source` (`TWILIO_WEBHOOK_BASE_URL` | `CRM_PUBLIC_URL_fallback` |
  `unset`) plus the exact `inbound_webhook_url`/`status_webhook_url` Twilio
  Console should be configured with. `crm-frontend/src/pages/SystemHealth.jsx`
  renders this: SMS-specific wording for recency/rejection (not the generic
  "lead" wording used by other inbound-webhook integrations), and a visible
  amber warning — "Set TWILIO_WEBHOOK_BASE_URL..." — whenever the fallback
  is in effect, so this specific misconfiguration can never again hide
  behind a "Connected"-looking card. URLs only, never a secret value.

**Not verifiable from this environment** (no Railway or Twilio Console
access here): whether `TWILIO_WEBHOOK_BASE_URL` has actually been set in
production yet, and whether Twilio Console's Messaging Service inbound
webhook URL is pointed at the backend's real domain. Checking System
Health's new `webhook_config`/`delivery_failures` card after this deploys —
and then having Michelle (or any test number) send one more real reply — is
the live verification step an operator must perform; do not treat inbound
SMS as fixed until that card confirms `TWILIO_WEBHOOK_BASE_URL` (not the
fallback) and a `0`/clean `delivery_failures` count after the env var is set.
`SMS_REPLY_NOTIFICATIONS_ENABLED`'s actual Railway runtime value is
similarly unverifiable from here — the rep-notification/Yaron-forward CODE
path is proven correct end-to-end once inbound processing itself succeeds
(see Regression coverage below), but whether that switch is actually set to
`'true'` in production is an operator fact, not a code fact.

Regression coverage: `test/smsClient.test.js` (the incident reproduced at
the signature-algorithm level: the real backend URL verifies, the frontend
URL never does; `webhookBaseUrl`/`webhookBaseUrlSource` precedence and
fallback-flagging); `test/systemHealthChecks.test.js` (`checkTwilio`'s new
`webhook_config`/`recency`/`delivery_failures` fields, including graceful
degradation on a DB failure); `crm-frontend/src/pages/SystemHealth.test.jsx`
(the warning banner renders only when falling back, never when
`TWILIO_WEBHOOK_BASE_URL` is correctly set); real-Postgres
`test/integration/sms.int.test.js` (a signature failure on either webhook
route is durably recorded with the exact expected URL and extracted
MessageSid/From; a correctly-signed request never writes a rejection row;
`getInboundWebhookHealth` reflects both). Found and fixed in the same pass:
`test/integration/smsReplyNotifications.int.test.js`'s own fake Twilio
client stub was missing the two relocated functions entirely, which made
`routes/sms.js`'s inbound handler throw before ever reaching
`handleInboundMessage` — silently swallowed as an empty-TwiML 200 — failing
2 of that file's 4 tests with no obvious connection to this change; fixed by
adding the two functions to that file's stub (the same stub shape
`test/integration/sms.int.test.js` already needed).

## SMS reply-notification visibility, out-of-order status callbacks, and a duplicate-notification race (October 2026, fixed)

**SUPERSEDED (November 2026) — read "SMS reply notifications: email-only, Yaron SMS forward retired" below first.** This section's `forwardToYaronBestEffort`/`SMS_REPLY_FORWARD_TO` design (Symptom 1 and bug #2 below) was removed entirely in a revised notification-design decision — inbound replies now notify exclusively by email. Kept here as the historical record of the out-of-order-callback fix and the `scripts/reconcileSmsMessageStatus.js` tool, both of which are unaffected and still current.

Following the previous incident's fix (inbound replies now actually reach
the backend), a real production report surfaced two further symptoms on the
SAME lead/thread, neither a consent/quiet-hours issue: (1) an inbound
customer reply ("What?") was correctly stored and displayed as Received in
the Text Message tab, but Yaron reported receiving no notification or SMS
copy on his personal phone; (2) an earlier outbound message ("test") stayed
displayed as Sent/Queued indefinitely, never progressing to Delivered.

**Symptom 1 — Yaron notification — root cause is configuration, not code.**
Per "Automated appointment SMS" above, an inbound reply's rep-notify and
Yaron-forward side effects are independently gated by
`SMS_REPLY_NOTIFICATIONS_ENABLED` (the rep's email via
`notifyAssignedRep`/`notifyUnmatchedForReview`) and, inside that same gate,
`SMS_REPLY_FORWARD_TO` (the mandatory-per-spec SMS copy to Yaron via
`forwardToYaronBestEffort`) — there is no third, in-app notification
mechanism anywhere in this codebase for an SMS reply. The code path itself
was already built and tested in the prior SMS work; the absence of a
notification means one or both env vars are not actually set to their
"on" values in the live Railway environment, which this environment has no
access to confirm or change. **New observability** (so an operator can
check this without raw Railway env var access):
`lib/systemHealthChecks.js#checkTwilio` now reports a `notification_config`
block — `reply_notifications_enabled` (mirrors
`smsReplyNotify.replyNotificationsEnabled()`) and `yaron_forward_configured`
(whether `SMS_REPLY_FORWARD_TO` is set) — never the destination number
itself. `crm-frontend/src/pages/SystemHealth.jsx` renders both as a plain
Enabled/Disabled-with-reason line on the SMS card. Until that card shows
both as Enabled, treat Yaron's notification as not yet armed in production,
not as broken code.

**Symptom 2 — stuck outbound status — most likely a casualty of the prior
incident, now has a catch-up tool.** A message sent before the
`TWILIO_WEBHOOK_BASE_URL` fix would have had its one and only status
callback attempt rejected for a bad signature (per the prior incident) —
and Twilio does not retry a rejected status callback indefinitely, so that
row is permanently stuck at whatever status it was inserted with unless
something reconciles it after the fact. **New tool**:
`scripts/reconcileSmsMessageStatus.js` (report-first,
`--apply --confirm-host=<host>` to write, mirrors the established
`auditTravelArtifacts.js`-style convention) finds every outbound
`sms_messages` row still in a non-terminal status
(`accepted`/`queued`/`sending`/`sent` — `sent` is NOT Twilio-terminal, it
can still become `delivered`/`undelivered`) older than a grace window
(default 10 minutes, `--minutes=N`), calls Twilio's real Message resource
(`lib/smsClient.js#getMessageStatus`, a new read-only GET — never sends
anything) for each one's `twilio_sid`, and with `--apply` writes the real
current status back via the SAME `normalizeSmsStatus`/known-status handling
`handleStatusCallback` already uses, so a status Twilio has introduced
since this code shipped still degrades safely rather than violating the
DB check constraint. **Not run against production from this environment**
(no `DATABASE_URL`/Twilio credential access here) — running this script
(report-only first, then `--apply` if it confirms the "test" message is
really stuck) against production is the remaining operator action for this
symptom; the code path that will fix it once run is built and tested.

**Two additional bugs found by code audit while investigating, both fixed
proactively because they bear directly on the acceptance criteria ("no
duplicate notifications", "status accurately reflects Twilio delivery")
even though neither was the literal reported symptom:**

1. **Out-of-order/duplicate status-callback regression**
   (`lib/smsService.js#handleStatusCallback`): Twilio does not guarantee
   callback delivery order, so a delayed earlier-stage callback (e.g. a
   slow `sending` arriving after a `delivered` already landed) could
   previously overwrite a message's status backward, making a genuinely
   delivered message appear to regress to an earlier state. Fixed with
   `OUTBOUND_STATUS_RANK` (accepted < queued < sending < sent <
   {delivered,undelivered,failed,canceled}, the four terminal
   outcomes sharing one rank, since none supersedes another): a callback
   whose status ranks lower than the row's current status is logged and
   ignored (`COALESCE` keeps the existing, more-advanced status); a
   forward transition or a different terminal outcome is still applied
   normally. `error_code`/`error_message` are still recorded from every
   callback regardless, since those are diagnostic, not a status
   regression.
2. **Duplicate-notification race in inbound message insertion**
   (`lib/smsService.js#handleInboundMessage`/`insertInboundMessage`): the
   prior implementation's existence check (a SELECT by `twilio_sid`) and
   insert (`INSERT ... ON CONFLICT (twilio_sid) DO NOTHING RETURNING *`)
   were separate steps; under genuine concurrent delivery of the same
   webhook (Twilio's own documented at-least-once retry behavior), both
   requests could see "no existing row," both attempt the insert, and the
   loser's `ON CONFLICT DO NOTHING RETURNING *` would correctly return no
   row — but the code at the time didn't handle that outcome, risking the
   loser treating it as a fresh message and double-firing
   `notifyAssignedRep`/`forwardToYaronBestEffort`. Fixed by re-querying the
   row by `twilio_sid` whenever the INSERT's `RETURNING` comes back empty,
   and reporting `duplicate: true` with the winning row in that case —
   `routes/sms.js`'s caller only fires the notification side effects when
   `duplicate` is false, so the race can no longer double-notify. The
   function was split into `handleInboundMessage` (existence check +
   delegate) and exported `insertInboundMessage` (the insert path alone)
   specifically so a test can plant a competing row directly and force the
   `ON CONFLICT` branch deterministically — a real `Promise.all` race
   proved too fast/reliable against local Postgres to trigger the specific
   internal window on demand, so that version is kept only as a secondary
   sanity check, not the primary regression proof.

Regression coverage: `test/smsService.test.js` (`OUTBOUND_STATUS_RANK`
shape/ordering, pure); `test/smsClient.test.js` (`getMessageStatus`
success/failure/config-missing, pure, confirms it only ever GETs); `test/
systemHealthChecks.test.js` (`notification_config`'s both-off/both-set/
partial shapes, never leaking the destination number);
`crm-frontend/src/pages/SystemHealth.test.jsx` (the new notification_config
card, including the never-shows-the-number assertion); real-Postgres
`test/integration/sms.int.test.js` (the out-of-order guard: a late
earlier-status callback ignored, a genuine forward transition applied, a
different terminal-status correction applied; the race fix: a row planted
directly, then `insertInboundMessage` called against the same
`twilio_sid`, proven to report `duplicate: true` with the pre-existing row
and never create a second one — verified to fail without the fix and pass
with it); `test/integration/reconcileSmsMessageStatus.int.test.js` (report
mode, `--apply` with correct/incorrect `--confirm-host`, the grace-window
and already-terminal exclusions, an unchanged-status report, a Twilio
`check_failed` row, and proof the script never calls a Twilio write
endpoint).

## SMS reply notifications: email-only, Yaron SMS forward retired (November 2026)

Revised notification-design decision, superseding the `forwardToYaronBestEffort`/
`SMS_REPLY_FORWARD_TO` mechanism introduced in "Automated appointment SMS"
and "SMS reply-notification visibility..." above. The business decided
inbound customer SMS replies should notify through the CRM's existing EMAIL
notification infrastructure only — never a second, paid outbound Twilio SMS
to Yaron's personal phone.

- **What changed**: `lib/smsReplyNotify.js#forwardToYaronBestEffort` (and
  its loop guard, its safety-note header, and its call site in
  `routes/sms.js`'s inbound webhook handler) has been REMOVED entirely —
  not merely left unconfigured. `notifyAssignedRep` (email to the lead's
  real assigned owner, via the `owners` FK) and `notifyUnmatchedForReview`
  (email to staff filtered through the EXISTING `notificationPreferences`
  `ACTIVITY` category) are UNCHANGED — they were already the correct,
  tested email path and needed no redesign.
- **How Yaron is notified now**: exactly like any other staff member — by
  email, as the lead's assigned owner (`notifyAssignedRep`) or via the
  staff `ACTIVITY` broadcast for an unmatched/ambiguous reply
  (`notifyUnmatchedForReview`, subject to his own notification preferences
  like every other staff recipient) — never via a personal-phone SMS copy.
- **Michelle's single-category policy is untouched by this change**: she
  was already correctly excluded from `notifyUnmatchedForReview`'s
  `ACTIVITY`-category broadcast (the SAME mechanism, unchanged — see
  "Michelle single-category policy" under "Important business invariants"
  below) and was never a target of the removed Yaron forward either. This
  retirement adds no new Michelle-specific logic because none was needed.
- **`SMS_REPLY_FORWARD_TO` must stay unset in production and is never
  read again** — `lib/systemHealthChecks.js#checkTwilio`'s
  `notification_config` block no longer has a `yaron_forward_configured`
  field at all (not merely `false`); a stray value left in the Railway
  environment is provably inert (see the "stray `SMS_REPLY_FORWARD_TO`"
  test in `test/systemHealthChecks.test.js`) — the feature cannot be
  silently revived by leaving old configuration in place. `SMS_REPLY_FORWARD_TO`
  was never enabled by this change and is not being enabled now.
  `SMS_REPLY_NOTIFICATIONS_ENABLED` is UNCHANGED and continues to gate the
  email path exactly as before — this flag was audited (not assumed) before
  this change and nothing about its meaning or call sites was altered.
- **No automated customer-facing SMS behavior was touched**: the booking
  confirmation and 12h/2h reminder SMS sends
  (`SMS_AUTOMATED_REMINDERS_ENABLED`), outbound manual-compose SMS, consent,
  opt-out, quiet hours, and the out-of-order status-callback guard / stuck-
  message reconciliation tool from the section above are all unmodified.
  `crm-frontend/src/pages/SystemHealth.jsx`'s SMS card now shows a single
  "Reply email notifications: Enabled/Disabled" line (the "Yaron SMS
  forward" line was removed, not merely hidden).
- Regression coverage: `test/smsReplyNotify.test.js` (the function and its
  export no longer exist; the remaining decoupled-gate test covers only the
  email path now); `test/systemHealthChecks.test.js` + `crm-frontend/src/
  pages/SystemHealth.test.jsx` (the retired field/line never reappears, a
  stray `SMS_REPLY_FORWARD_TO` is never read or rendered); real-Postgres
  `test/integration/smsReplyNotifications.int.test.js` (every inbound-reply
  scenario — unique match, redelivered webhook, ambiguous match, STOP
  keyword — proves email fires correctly and NO outbound SMS is ever sent
  as a reply notification).

## CRM email notification links: centralized, validated base URL (`lib/crmUrl.js`, November 2026, fixed)

**Production incident**: a New Lead notification email's "Open Lead in CRM"
button opened `http:///leads/774d31bd-1134-4319-8298-5810dbe196a5` on mobile
when clicked — scheme present, host EMPTY. Google's own redirect
interstitial correctly flagged it "invalid url".

**Root cause**: `lib/captureAlerts.js#sendNewLeadAlert` (the New Lead email —
every intake path funnels through it) built its lead link as
`` `${crmPublicUrl || ''}/leads/${lead.id}` `` with **no fallback of its
own**, and all three of its real callers —
`routes/websiteLeads.js`, `routes/publicCapture.js`, `routes/metaWebhook.js`
(×2 call sites) — passed `process.env.CRM_PUBLIC_URL || ''`. When
`CRM_PUBLIC_URL` was unset in production, the email shipped a bare
**relative** path (`/leads/<id>`, no scheme, no host) baked directly into
its HTML. There is no "current page" inside an email to resolve a relative
`href` against, so Gmail's own link-safety/redirect wrapper rendered
exactly the reported symptom. The identical missing-fallback pattern
existed in `routes/sms.js`'s inbound-SMS-reply notification path
(`lib/smsReplyNotify.js#notifyAssignedRep`), degrading more gracefully (it
omitted the link entirely rather than emit a broken one) but still shipping
a notification with no way to open the lead at all — found while auditing
every "any other email containing a link back to CRM" per the same
investigation. Every OTHER CRM-link call site in this codebase had already
independently reinvented the same
`process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com'`
fallback — duplicated across 8+ files, each copy a chance to be missed
exactly like `captureAlerts.js` was. A ninth, previously-undiscovered copy
of the SAME missing-fallback bug was also found and fixed in the SAME pass,
unprompted: `routes/auth.js`'s employee-invite email built its
`/accept-invite?token=...` link from `process.env.CRM_PUBLIC_URL || ''`
too — same defect class, same fix.

**Fix**: `lib/crmUrl.js` is now the ONE validated source for every CRM-link
call site. `getCrmBaseUrl()` ALWAYS returns a valid absolute `http(s)` URL
with a real host — falling back to the known production CRM URL
(`https://crm.ecconstructiongroup.com`) whenever `CRM_PUBLIC_URL` is unset,
unparsable, missing a protocol/host, or points at a blocked host
(`localhost`/`127.0.0.1`/`0.0.0.0`/`::1`, any `*.railway.internal`, any
`base44.app`/`base44.com`) — logging a warning only for the invalid/blocked
cases, never for the simply-unset case (`CRM_PUBLIC_URL` is documented as
"Recommended," not "Required"). Deliberately does NOT block a
`*.up.railway.app` domain — `lib/platformInfraProvisioning.js` legitimately
sets a brand-new multi-company installation's real `frontend_url` to
exactly that shape before a custom domain is attached (see "Multi-company
direction" below), so that is a genuine working CRM origin, not a
misconfiguration. `buildLeadUrl(leadId)` builds on top of it and returns
`null` when `leadId` is missing — every caller must omit the link/button
entirely in that case rather than ever emit a bare `/leads/` or
`/leads/undefined`. `/leads/:id` was verified (not assumed) as the real
frontend route — `crm-frontend/src/App.jsx` routes it to
`LeadDetailModern`.

Every call site that used to read `process.env.CRM_PUBLIC_URL` directly now
delegates to this module: `lib/captureAlerts.js`, `lib/smsReplyNotify.js`,
`lib/dataAccessRailway.js`, `lib/emailTemplates.js`, `lib/reminderEmails.js`,
`lib/reminderPages.js`, `lib/actionRouter.js`, `lib/crmActivityNotifier.js`,
`routes/cronJobs.js`, `lib/phoneCallReminders.js`, `lib/qbTokenManager.js`
(the QuickBooks reconnect-required admin alert), and `routes/auth.js` (the
employee-invite email AND the Google OAuth `redirect` default). The three
broken New Lead call sites (`routes/websiteLeads.js`,
`routes/publicCapture.js`, `routes/metaWebhook.js`) and `routes/sms.js`'s
inbound-SMS-reply call site no longer pass a raw env-var string at all —
`sendNewLeadAlert`'s and `notifyAssignedRep`'s second `crmPublicUrl`
argument is now an accepted-but-ignored, documented-deprecated parameter
(kept only so no caller needed its call signature changed), and the link is
unconditionally built from `lib/crmUrl.js` inside the function itself.

**Deliberately NOT touched**: `crm-frontend/src/lib/crmEmailTemplates.js`'s
`manualStaffReminderHtml` (the browser-triggered "manual reminder" email,
`crm-frontend/src/lib/emailTransport.js`'s Railway-flow path) builds its
link from `window.location.origin` — this runs IN THE BROWSER, so the
origin is always correct by construction (whoever is viewing the CRM to
click "send manual reminder" is necessarily on the right host); there is no
env-var fallback to get wrong, and it needed no fix. `routes/platformCompanies.js#sendOwnerInvite`
(multi-company owner invites) intentionally uses each company's own
per-row `frontend_url` from `platform_companies`, never the global
`CRM_PUBLIC_URL` env var — a different, already-correct mechanism, not an
instance of this bug. `lib/smsClient.js#webhookBaseUrl` reads
`CRM_PUBLIC_URL` too, but only as a documented last-resort fallback for the
Twilio webhook/status-callback BACKEND URL (a different purpose entirely —
see "SMS inbound-webhook / status-callback production incident" above) —
not a lead link, not touched here.

**Known, NOT-fixed-in-this-pass issue found while reading this code**:
`lib/qbTokenManager.js#notifyReconnectRequired` destructures
`const { ALERT_RECIPIENTS } = require('./captureAlerts')` — but
`lib/captureAlerts.js` does not (and, per its current `module.exports`,
never did in its current form) export `ALERT_RECIPIENTS`. This makes
`ALERT_RECIPIENTS` `undefined` in production, so the `for...of` over it
throws and is silently swallowed by the function's own try/catch — the
QuickBooks reconnect-required ADMIN alert email has likely never sent in
production. Every test file that exercises code paths near this (`test/
integration/company2FunctionalProof.int.test.js` and 10+ others) masks this
by stubbing the whole `lib/captureAlerts` module with its own
`ALERT_RECIPIENTS: []`, which is why it was never caught by the existing
suite. This is a genuinely separate defect (an email never sending, not a
malformed link) from everything else in this section — tracked here as a
known issue, deliberately not fixed in this pass to keep this fix scoped to
link generation.

### Post-login redirect now preserves the intended lead (`lib/safeReturnTo.js`)

A related gap found while auditing requirement coverage for this incident:
a user who followed a New Lead or incoming-SMS email link while logged out
was always dropped on the dashboard after signing in — `crm-frontend/src/
App.jsx`'s `auth_required` branch discarded the original URL entirely
(`<Navigate to="/login" replace />`), and every success path in
`crm-frontend/src/pages/Login.jsx` (Google SSO, email/password, and the
already-authenticated redirect) always navigated to `/` unconditionally.

Fixed by threading a validated `returnTo` path through the whole flow:
`App.jsx` now preserves the original `location.pathname + location.search`
as `/login?returnTo=<path>`. `lib/safeReturnTo.js` (backend) and
`crm-frontend/src/lib/safeReturnTo.js` (frontend, duplicated — separate
packages, no shared module boundary) are the ONE validated gate a `returnTo`
value must pass before ever being used as a redirect target — it must be a
same-origin, app-internal path starting with exactly one `/` (never
`//host/...` or `/\host/...`, both browser-recognized protocol-relative
forms, and never an absolute URL or a disguised scheme like
`/javascript:...`) — an open-redirect vector is the one thing this can
never become, since a freshly-issued session's tokens travel with it.
For the email/password path, `Login.jsx` reads `returnTo` straight back off
`window.location.search` (same page, no navigation occurred). For Google
SSO, which does a full off-site round trip through Google, the value is
carried through `routes/auth.js`'s existing `state` parameter (the same
CSRF-nonce mechanism that already carried the frontend origin) —
`GET /google` accepts an optional `?returnTo=` query param, validates it,
and embeds it in `state`; `GET /google/callback` decodes and re-validates it
(defense in depth — `state` is attacker-visible/replayable, never trusted on
faith alone) and appends it to the final `#access=...&refresh=...` hash
redirect as `&returnTo=...`; `Login.jsx`'s existing hash-token handler reads
it back and navigates there instead of always `/`.

**Permissions are unaffected by design, not by new code**: preserving the
destination never bypasses lead ownership or role restrictions — once
signed in, `LeadDetailModern`'s data fetch still goes through the normal
authenticated API, which still enforces `routes/leads.js#resolveOwnerScope`
exactly as it does for any other navigation. A `returnTo` to a lead the
signed-in user isn't authorized to see still gets that user the same 403/
scoped-empty response the API would give for any other route to it — this
needed verification, not new code.

Regression coverage: `test/crmUrl.test.js` (`getCrmBaseUrl`/`buildLeadUrl`
validation matrix — unset, empty, valid http/https, unparsable, blocked
hosts including the exact `http://` bare-scheme shape, `*.up.railway.app`
NOT blocked, missing leadId, URL-encoding); `test/captureAlerts.test.js`
(NEW — this file had zero coverage before this incident; proves the New
Lead email's link is always valid absolute HTTPS regardless of
`CRM_PUBLIC_URL`, and that the deprecated `crmPublicUrl` argument is fully
ignored); `test/smsReplyNotify.test.js` (the incoming-SMS reply email's
link is always valid, never omitted); `test/safeReturnTo.test.js` +
`crm-frontend/src/lib/safeReturnTo.test.js` (the open-redirect-rejection
matrix on both sides). **Not verified live** (no Railway/Twilio/Google
OAuth credential access in this environment): the actual rendered HTML of a
real production email (Gmail-specific link mangling can only be confirmed
by receiving one), and a full Google-SSO round trip exercising the new
`returnTo` passthrough end to end — both require live production access an
operator must perform.

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
  - **Updated October 2026 — a real live round-trip WAS performed**: a
    controlled outbound send to Michelle Roitman's test lead succeeded, but
    her reply never appeared — root-caused and fixed (see "SMS
    inbound-webhook / status-callback production incident" above:
    `routes/sms.js` was verifying Twilio's signature against `CRM_PUBLIC_URL`,
    this codebase's established name for the FRONTEND's URL, never the
    backend's). **Still not verifiable from this environment** (no Railway/
    Twilio Console access here): whether `TWILIO_WEBHOOK_BASE_URL` has
    actually been set on the `qb-proxy-server` service since this fix
    deployed, and whether Twilio Console's Messaging Service inbound webhook
    URL points at that same backend domain. System Health's `webhook_config`
    card (added in that same fix) is the one place to confirm both without
    needing either kind of access — do not treat inbound SMS/status
    callbacks as operational until it shows `TWILIO_WEBHOOK_BASE_URL` (not
    the `CRM_PUBLIC_URL_fallback`) and a clean `delivery_failures` count
    after a fresh test reply. Real-Postgres coverage (fake Twilio client, no
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

**`crm-frontend/src/components/HandoffEstimatesPanel.jsx` previously had a
SECOND, unrelated path back into the direct Handoff API (production
incident, found and fixed in a later pass)**: alongside the correct
"Sync from QuickBooks" button (`handleSync` → `syncQBEstimatesForLead` →
`routes/leadQB.js`'s `sync-estimates`, per the pipeline above), this
per-lead panel ALSO offered a second, visually near-identical "Sync from
Handoff" icon (`handleHandoffSync` → `POST /handoff/sync-estimates-for-lead`,
`routes/handoffSync.js` — the DIRECT Handoff REST integration). Clicking it
always failed with `EXTERNAL BLOCKER — OFFICIAL HANDOFF API KEY REQUIRED...`
(`routes/handoffSync.js#classifyHandoffError`'s `OFFICIAL_API_KEY_REQUIRED`
message), since this installation has no Handoff API key and, per this
section's own opening paragraph, is not pursuing one. That error rendering
in the SAME panel as an unrelated, correct "No estimates yet" empty state
(a lead whose QuickBooks-side match simply hadn't synced yet) read as one
combined failure, even though the two had nothing to do with each other —
the QB-based pipeline (cron + this panel's auto-sync + its remaining
"Sync from QuickBooks" button) was never affected; the direct-Handoff
button's own failure never touched the `handoff_estimates` table at all
(`handoffClient.getApiKey()` throws before any `rda.create`/`rda.update`
is ever reached), so no estimate data was ever at risk from this. Fixed by
removing the "Sync from Handoff" button and its handler entirely from this
panel — the backend route (`routes/handoffSync.js`) is untouched, since a
future installation that genuinely configures a direct Handoff connection
may still use it elsewhere; only this panel's dependency on it was removed.
Confirms requirement: `enabled_modules.handoff` must in fact be `true` in
this installation's production `company_settings` row for the reported
`EXTERNAL BLOCKER` message to have been reachable at all — if it were
`false`, `routes/handoffSync.js`'s own `gate()` (`requireModuleEnabled`)
would have 404'd with `module_disabled` first, never reaching
`classifyHandoffError`'s `OFFICIAL_API_KEY_REQUIRED` message. That module
flag's actual current value was not independently verified against
production from this environment (no Railway/DB access) — this is a
code-level deduction from the exact error text reported, not a live check.
Regression coverage: `crm-frontend/src/components/HandoffEstimatesPanel.test.jsx`
(no "Sync from Handoff" control renders; auto-sync and the diagnose/sync
buttons never call the direct Handoff API; the empty state never shows an
`EXTERNAL BLOCKER`/`HANDOFF_API_KEY` message); the QB-only dependency of
the sync-estimates write path itself was already covered by
`test/estimateSyncRestoration.test.js`'s "no dependency on Handoff
API/HANDOFF_API_KEY" test, unchanged by this fix.

## QuickBooks authorization, idempotency, and proactive monitoring (October 2026 reliability audit, Phase 2)

Follow-up pass to the reconnect-alert fix above, closing the remaining
gaps the same audit found in `server.js`'s legacy QB proxy write surface.
Nothing about `lib/qbTokenManager.js`'s refresh/rotation/locking logic
changed — this phase is authorization, duplicate-write prevention, and a
new proactive health probe layered on top of it.

- **Authorization — role-gating the legacy QB proxy write routes.**
  `server.js#requireProxySecret` accepts EITHER the server-to-server
  `X-Proxy-Secret` header OR any valid Railway JWT, with NO role check on
  the JWT path. Every legitimate caller on the proxy-secret path
  (`lib/qbInternal.js`, used by `routes/leadQB.js` and
  `routes/dealQbSync.js`) is already gated one layer up with
  `requireRole('admin','manager')` — but a browser could reach these
  routes DIRECTLY with ANY authenticated user's JWT (`sales_rep`, `office`,
  anyone), completely bypassing that upstream gate, since this middleware
  never checked `req.user.role`. Fixed with a new
  `lib/qbRouteAuth.js#requireProxySecretOrRole(...roles)` — a separate,
  independently `require()`-able and unit-testable module (not inlined in
  `server.js`, so it can be tested without eval-extracting a source
  fragment): the `X-Proxy-Secret` path is UNCHANGED (still unconditional —
  restricting it too would double-gate, and could break, the legitimate
  internal calls above); the JWT path now additionally requires
  `req.user.role` to be one of the roles the specific route allows.
  - **Admin-only** (an administrative action with real credential
    consequences): `GET /auth/connect`, `POST /auth/callback`,
    `POST /auth/disconnect`, and their `POST /qb/auth-connect` /
    `/qb/auth-callback` / `/qb/auth-disconnect` aliases.
    `GET /auth/status` / `POST /qb/auth-status` (read-only connection
    status) is deliberately left on the unrestricted `requireProxySecret`
    — reading status has no credential/financial consequence and is
    needed by `QBReconnectBanner.jsx` and others.
  - **Admin/manager** (preserves the existing manager-workflow precedent
    already established in `routes/dealQbSync.js` and `routes/leadQB.js`):
    `POST /customers`, `POST /estimates`, `POST /invoices` (both the
    create path and its `operation==='void'` fallback), `POST
    /invoices/:id/void`, `POST /qb/sync-lead`.
  - Every GET/read-only QB proxy route (`GET /customers`, `GET
    /estimates`, `GET /invoices`, `/qb/lead-status`, `/qb/diagnose-*`,
    `/qb/resync-all`, `/qb/import-estimates`, `/qb/sync-lead-estimates`,
    etc.) is UNCHANGED — confirmed via code audit to perform no QuickBooks
    writes at all, so there is no financial-mutation risk to restrict.
  - **Frontend**: `crm-frontend/src/pages/Integrations.jsx`'s
    Connect/Reconnect/Disconnect buttons (including the Sandbox banner's
    own Disconnect button) now render only for `currentUser?.role ===
    'admin'`; a non-admin sees an explanatory note instead. This is a UX
    courtesy only — the real enforcement is the server-side gate above; a
    bypassed/stale frontend would still get a 403.
  - Regression coverage: `test/qbRouteAuth.test.js` (the real middleware
    behavior — proxy-secret bypass, each role tier, 401 vs 403, invalid/
    expired JWT), `test/qbLegacyWriteRouteSecurity.test.js` (source-level
    proof every listed route in `server.js` is actually wired to the
    correct gate — same "source-level" convention this file already uses
    for `isManuallyMatched`/`runQbEstimateSync`, since `server.js` has
    top-level side effects and isn't a requirable module),
    `crm-frontend/src/pages/Integrations.qbAuth.test.jsx` (admin sees the
    control; manager and sales_rep do not).

- **Duplicate-write protection on the same legacy write routes.** None of
  `POST /customers`, `/estimates`, `/invoices`, `/qb/sync-lead` had any
  lock at all — a double-click, a network retry, or two near-simultaneous
  requests for the same customer/estimate/invoice could each see "doesn't
  exist yet" and both create one, producing a real duplicate QuickBooks
  record. (Verified via code audit that NOTHING in the live frontend or
  any internal caller actually calls the bare `POST /customers`,
  `/estimates`, or `/invoices` today — only `GET` — so this was a
  dormant/legacy risk, not an active-path defect; `/qb/sync-lead` IS
  actively called, via `lib/qbInternal.js` ← `routes/leadQB.js`, and had
  the same no-lock gap.) Fixed by extracting the SAME advisory-lock
  pattern `lib/qbEstimateInvoice.js#withDealLock` already uses into a
  shared, generic `lib/advisoryLock.js#withAdvisoryLock(pool, namespace,
  key, fn)` — the first place this pattern is shared rather than
  re-copied a fourth time (see that file's header for the full list of
  namespaces already in use: 1001 appointment booking, 1002 lead intake,
  1003 QB deal estimate/invoice, **1004 — new — these legacy QB proxy
  write routes**). `server.js#withQbWriteLock(key, fn)` wraps it with the
  1004 namespace and `saleDb.pool`:
  - `POST /customers` locks on `customer:<DisplayName>` and re-checks QB
    directly (the same find-by-DisplayName query `/customers/search`
    already uses) before creating — a duplicate DisplayName returns the
    EXISTING customer instead of creating a second one.
  - `POST /estimates` and the `POST /invoices` create path lock on
    `estimate:<CustomerRef>:<DocNumber>` / `invoice:<CustomerRef>:<DocNumber>`
    and re-check QB directly the same way — ONLY when the payload has both
    fields (a realistic QB Estimate/Invoice always does); a payload
    missing either falls through to a plain forward, since there is no
    natural key to dedupe on in that case.
  - `POST /invoices/:id/void` and the `POST /invoices`
    `operation==='void'` fallback both lock on `invoice-void:<Id>` and
    re-check the NEW `lib/qbInvoiceSaleMap.js#isVoided(db, qb_invoice_id)`
    helper (reads `qb_invoices_cache.voided`, the same column
    `markVoided` already sets) before calling QuickBooks' void operation
    — an invoice already recorded voided returns `{success:true,
    already_voided:true}` without a second QB API call.
  - `POST /qb/sync-lead`'s find-or-create now locks on the SAME
    `customer:<DisplayName>` key `POST /customers` uses — closing both its
    own internal race (it previously had zero locking) and a cross-route
    race between the two endpoints for the same DisplayName.
  - No existing financial data was changed or re-created by this fix — it
    only prevents a FUTURE duplicate on retry/concurrency; a pre-existing
    duplicate (from before this fix) is not detected or merged.
  - Regression coverage: `test/advisoryLock.test.js` (lock/unlock pairing,
    releases on throw, client always returned to the pool, independent
    keys don't cross-couple).

- **Proactive scheduled connection health check — the "detection is purely
  reactive" gap.** Previously the ONLY ways a revoked/expired QuickBooks
  grant was ever discovered were: the 15-minute QB sync crons' real API
  calls happening to fail, or an admin manually clicking "Run Live
  Checks"/hitting `?verify=1` — there was no standalone scheduled probe.
  `lib/qbProactiveHealthCheck.js` adds one WITHOUT inventing any new
  refresh, credential, or notification mechanism: it calls the existing
  `qbTokenManager.verifyConnection()` (a read-only companyinfo GET through
  the canonical `qbApiRequest` path) on an hourly cron tick
  (`server.js`, `0 * * * *`). If that live call (or the refresh it may
  trigger) discovers the grant is genuinely revoked,
  `lib/qbTokenManager.js#interpretRefresh` ALREADY calls
  `deps.notifyReconnectRequired` with its existing per-day, per-recipient
  idempotency key (the exact path fixed earlier in this document) — this
  adds NO second alert path and cannot itself cause alert spam beyond what
  that existing dedup already prevents.
  - **Avoids unnecessary Intuit API usage**: `shouldSkipProactiveCheck`
    skips the live call entirely when a real QuickBooks API call already
    succeeded more recently than 20 minutes ago (comfortably longer than
    the 15-minute sync crons' own interval — their ordinary traffic
    already proves the credential live, so this backs off rather than
    probing redundantly).
  - **OFF by default — explicit opt-in required**
    (`QB_PROACTIVE_HEALTH_CHECK_ENABLED=true`), mirroring this codebase's
    established safe-by-default precedent (`REMINDER_DRY_RUN`, the SMS
    automation's three activation gates): this calls a code path that CAN
    trigger a real token refresh (the same one the existing sync crons
    already trigger routinely), just on an additional schedule, so an
    operator should confirm that schedule before it runs unattended in
    production. **Not yet enabled in this pass** — enabling it is a
    deliberate follow-up operator action, not a side effect of this
    commit.
  - No new Railway service was created — this runs as a cron tick inside
    the existing `qb-proxy-server` process, the same way the two existing
    15-minute QB crons do.
  - Regression coverage: `test/qbProactiveHealthCheck.test.js` (the skip
    decision in isolation — never-connected, recently-verified, and due
    cases; `runProactiveHealthCheck`'s dependency-injected wiring, proving
    it never calls `verifyConnection` when skipping and correctly surfaces
    `reconnectRequired` when it doesn't); the cron's own wiring (env-var
    gate, correct require) is covered by
    `test/qbLegacyWriteRouteSecurity.test.js`'s source-level check.

## QuickBooks rate-limit (429) production incident, System Health misclassification (October 2026 reliability audit, Phase 3)

**Production report**: System Health showed QuickBooks's live-check message
as `"QuickBooks API returned HTTP 429 — likely transient"` while
simultaneously presenting the integration as **Disconnected**. Railway logs
showed `[qb-token] access token refreshed` (the refresh itself succeeded)
immediately followed by `[qb-inbound-cron] reconcile ok — total=100
synced=0 failed=100`, repeating every 15 minutes.

**Root cause #1 — `lib/qbTokenManager.js#qbApiRequest` had NO retry/backoff
for a 429 or 5xx on an actual QuickBooks DATA call, only for a 401.** The
QB Estimate Sync cron and the QB Inbound Reconciliation cron both fire on
the identical `*/15 * * * *` schedule in the same process; the inbound
reconciliation loop alone issues at least 2 sequential QB calls (Invoice
query + Payment query, more if paginated) per mapped customer with ZERO
pacing between them. At ~100 mapped customers that is 200+ rapid-sequential
calls — enough to exceed Intuit's rate limit on its own, and the OVERLAPPING
estimate-sync cron tick compounds it further. The token-refresh endpoint's
OWN 3-attempt backoff (`REFRESH_ATTEMPTS`/`REFRESH_BACKOFF_MS` in
`callIntuit`) is a completely separate HTTP endpoint (`/oauth2/v1/tokens/
bearer`) and never covered this — confirmed by `test/qbTokenManager.test.js`'s
own existing "transient Intuit 5xx/429" tests, which exercise only
`getValidTokens` (the refresh path, `intuitResponse`/`intuitCalls`), never
`qbApiRequest`'s data-call path (`apiResponse`/`apiCalls`) — that test gap is
exactly what let this ship. Once Intuit's limit was hit mid-run, every
subsequent call failed immediately with no retry, cascading into
"failed=100" for the whole tick.

**Fix**: `qbApiRequest` now bounded-retries a 429/5xx with backoff
(`DATA_CALL_RETRY_ATTEMPTS = 3`, `DATA_CALL_BACKOFF_MS = [500, 1500]` —
deliberately the SAME shape as the already-reviewed refresh-endpoint
backoff, for consistency) — honoring a `Retry-After` header when Intuit
sends one, capped at `DATA_CALL_MAX_RETRY_AFTER_MS = 5000` so a
misbehaving/huge value can never stall a cron tick. This is the ONE shared
path every QuickBooks data call goes through (`server.js` `qbFetch`, the PDF
routes, `qbInboundSync.qbQuery`, `qbSyncTrigger`, `qbEstimateInvoice`), so
the fix applies uniformly with no per-call-site duplication. The existing,
independently-tested 401-refresh-and-retry-once behavior is completely
unchanged — the two retry budgets (401 vs. 429/5xx) are tracked
independently and never consume each other's slot.
`lib/qbInboundSync.js#syncAllMappedCustomers` also now paces
`INTER_CUSTOMER_PACING_MS = 200` between customers (never after the last
one) — a small, additive mitigation that reduces how often the retry budget
even needs to be spent, not a replacement for the retry fix.
`server.js`'s qb-inbound-cron HTTP call timeout was raised from 100s to
280s (comfortably under the 15-minute tick spacing) to accommodate the new
worst-case duration (100 customers × up to 2 calls × up to ~2s backoff +
pacing, under a SUSTAINED rate-limit) — without this, the cron's own HTTP
call could itself time out before the (now more resilient) reconciliation
finished, losing visibility entirely.

**Root cause #2 — the per-customer failure reason was computed but never
reached the logs.** `syncCustomerFinancials`'s per-customer `error`/now
`error_status` (the attempted fix's new field — see below) WAS already
returned in `syncAllMappedCustomers`'s `results` array and even forwarded
in the cron route's HTTP response body — but `server.js`'s cron tick only
ever destructured and logged the aggregate `total`/`synced`/`failed`
counts, discarding `results` (and the body itself) immediately after each
tick. An operator seeing "failed=100" in Railway logs had NO way to learn
WHY without separately hitting System Health's `?verify=1` live-check path
— a completely different code path that happened to also reveal it this
time only because the SAME root rate-limit condition was still active when
checked. **Fix**: `lib/qbInboundSync.js#qbQuery` now attaches `.status` to
its thrown error (so a caller can classify a failure without parsing the
error-message text, which is still truncated to 200 chars and never
includes a token, customer PII, or a financial amount beyond what the
200-char truncation already bounded); `syncAllMappedCustomers` returns a
new `failureSummary` field — HTTP-status-keyed COUNTS only (e.g.
`{status_429: 97, status_500: 3}`), never a raw body — and `server.js`'s
cron tick now logs it (`console.warn`) whenever `failed > 0`.

**Root cause #3 — `lib/systemHealthChecks.js#deriveState` never actually
reached its own `DEGRADED` branch for a failed-but-transient live check.**
The function's OWN doc comment already described `DEGRADED` as covering "a
caveat (transient error...)", but the code's condition order
(`result.live_check.ok && result.live_check.degraded`) required `ok` to be
`true` — and a genuine transient FAILURE (what `liveCheck(false, true,
...)` means — `ok: false` because the call genuinely failed, `degraded:
true` specifically to flag that failure as non-fatal/transient) never
satisfies that. A grep across every `liveCheck(...)` call in this file
confirmed the scope of this: QuickBooks's 429/5xx case
(`checkQuickBooks`), a Google Calendar quota error, a bare network/timeout
exception caught in Gmail/SignNow/Handoff/Twilio's own catch blocks, and
even the top-level "health check itself failed" catch-all in
`getIntegrationHealth` ALL produce exactly this `ok:false, degraded:true`
shape — and every one of them fell through to the final `DISCONNECTED`
fallback, undetected, because the only existing direct test of
`deriveState()` tested exactly 3 combinations (`{true,false}`,
`{true,true}`, `{false,false}`) and never the 4th
(`{false,true}`) — the ACTUAL shape nearly every transient-failure call
site in this file produces. Fixed by checking `degraded` before requiring
`ok`: `if (result.live_check.degraded) return 'DEGRADED';` now runs before
the `DISCONNECTED` fallback, so a transient failure and a transient
"succeeded with a caveat" (Handoff's own `liveCheck(true, true, ...)`
warning case — the one pre-existing scenario that COULD already reach
`DEGRADED`) land on the same, correct state. This fix is NOT
QuickBooks-specific — it corrects System Health's reporting for every
integration's transient-failure case, not just the one that was reported.

**Verified (not claimed) production behavior vs. code-level conclusions**:
everything above is a code-level root-cause analysis and fix, verified by
reading the actual shipped source and by regression tests that reproduce
the exact reported shapes (`test/qbTokenManager.test.js`'s new
`qbApiRequest` data-call tests, `test/qbInboundSync.test.js`,
`test/systemHealthChecks.test.js`'s new end-to-end
`checkQuickBooks`-through-`deriveState` test). Whether the PRODUCTION
QuickBooks connection is currently rate-limited right now, whether this
fix actually resolves the live "failed=100" pattern once deployed, and
Intuit's actual effective rate limit for this specific app/realm are **not
verifiable from this environment** (no Railway/Intuit production access
here) — confirming the fix worked live (System Health showing
`CONNECTED`/`DEGRADED` instead of `DISCONNECTED` during a transient blip,
and the next few `qb-inbound-cron` log lines showing `synced` counts
recover) is the remaining operator verification step.

Regression coverage: `test/qbTokenManager.test.js` (qbApiRequest's new
429/5xx bounded retry, `Retry-After` honoring and capping, independent
401-vs-transient retry budgets); `test/qbInboundSync.test.js` (pacing
between customers, the sanitized `failureSummary`, the zero-failure and
single-customer edge cases); `test/systemHealthChecks.test.js` (the
missing `{ok:false, degraded:true}` -> `DEGRADED` case, and a full
`checkQuickBooks`-through-`deriveState` pipeline test reproducing the
exact reported incident shape end-to-end).

## QuickBooks sustained-429 circuit breaker + cross-process cron locking (October 2026 reliability audit, Phase 4)

**Production incident, round 2**: after the Phase 3 fix above shipped,
Railway logs continued to show `[qb-token] QuickBooks API 429 — transient,
retry 1/2 (1000ms)` / `retry 2/2 (1000ms)` repeating almost every second,
for extended periods. The per-call bounded retry (Phase 3) was working
exactly as designed — it just had nothing above it to stop a **sustained**
rate limit from being retried, call after call, for the full duration of a
tick.

**Root cause, confirmed by reading the actual loops, not guessed**: TWO
scheduled jobs register on the IDENTICAL `*/15 * * * *` cron string in the
same process (`server.js`'s QB Estimate Sync cron and QB Inbound
Reconciliation cron, registered one after another) — both fire concurrently
at every 15-minute boundary, stacking their QB call volume. Phase 3 only
paced `lib/qbInboundSync.js#syncAllMappedCustomers`'s loop (200ms between
customers); it never touched TWO OTHER unpaced loops that run on the exact
same schedule: `server.js#runQbEstimateSyncInner`'s `fetchQbCustomer` calls
(one QB customer fetch per estimate needing a not-yet-cached customer, zero
pacing) and `runQbEstimatePdfSync`'s per-estimate PDF fetch loop (also zero
pacing, up to 500 estimates per tick). Under a sustained limit, each
unpaced call still fails, retries twice at ~1s each (honoring `Retry-After`,
per Phase 3), then immediately moves to the next item — which 429s again —
producing exactly the reported "almost every second" log pattern, and
potentially helping to KEEP the rate-limit window from ever clearing by
never backing off at the tick level, only at the per-call level.

**Fix — four independent, coordinated pieces:**

1. **Shared, cross-process circuit breaker** (`lib/qbRateLimitBreaker.js`,
   NEW) — a classic closed/open/half-open state machine, state stored in
   the pre-existing `app_settings` key-value table (`key='qb_rate_limit_breaker'`)
   rather than in-process memory, so it is correct across multiple Railway
   replicas/processes, not merely within one Node process:
   - **CLOSED**: every call proceeds normally.
   - **OPEN**: `FAILURE_THRESHOLD` (5) consecutive TERMINAL failures (i.e.
     AFTER `qbApiRequest`'s own Phase 3 retry budget is already exhausted —
     an isolated blip that the retry already recovered from never counts)
     trips the breaker for a cooldown starting at `BASE_COOLDOWN_MS` (1
     minute), doubling on each repeated reopen, capped at `MAX_COOLDOWN_MS`
     (10 minutes), plus bounded jitter.
   - **HALF_OPEN**: once the cooldown elapses, exactly ONE caller (the
     first to win a conditional, atomic single-row UPDATE) is let through
     as a trial; success closes the breaker completely, failure reopens it
     with a longer cooldown. A trial that never reports back (a crash/hang)
     self-recovers after `HALF_OPEN_TIMEOUT_MS` (30s) rather than deadlocking
     every future call forever.
   - Wired into `lib/qbTokenManager.js#qbApiRequest` (the one canonical
     path every QuickBooks DATA call already goes through) as a gate
     checked BEFORE any network call or token lookup — while open, it
     returns a synthetic failure (`res.status = the string 'circuit_open'`,
     never a number, so it can never be mistaken for a real Intuit HTTP
     status in a log or `failureSummary`) with ZERO network traffic. This
     protects every caller uniformly: inbound reconciliation, estimate
     sync, PDF sync, the legacy proxy routes, `qbSyncTrigger`.
   - Deliberately NEVER applied to the OAuth token-refresh endpoint
     (`callIntuit`/`interpretRefresh` — a completely separate HTTP call) —
     the breaker is about data-call rate limiting, never about whether a
     token can be refreshed, per the explicit requirement that rate
     limiting must never be confused with a revoked/expired credential.
   - Fails OPEN on its own error (a transient `app_settings` read/write
     hiccup never blocks a real QuickBooks call) — see the try/catch around
     every `qbRateLimitBreaker` call in `qbTokenManager.js`.
2. **Early-exit instead of grinding through the rest of a doomed loop** —
   `lib/qbInboundSync.js#syncAllMappedCustomers`, `server.js#runQbEstimateSyncInner`,
   and `server.js#runQbEstimatePdfSync` all now stop iterating the moment a
   call reports the breaker is open (`circuitOpen`/`circuit_open` propagated
   through `qbQuery`/`qbFetch`/`fetchQbCustomer`'s thrown errors), setting
   `stopped_early: true` on the returned stats, rather than continuing
   through dozens more already-doomed, breaker-blocked items. A PDF-fetch
   skip specifically is NEVER recorded as a real failure (no `pdf_status:
   'failed'`, no burned retry attempt) — it is a no-op skip, not a genuine
   PDF-fetch error.
3. **Previously-unpaced loops now paced** — `runQbEstimateSyncInner`'s
   `fetchQbCustomer` loop and `runQbEstimatePdfSync`'s PDF loop each gained
   a light ~150ms pace between items (never after the last one), matching
   `qbInboundSync.js`'s existing 200ms convention — an additive mitigation
   that reduces how often the breaker's retry budget needs to be spent at
   all; the breaker itself is what actually stops a sustained condition.
4. **Cross-process/replica-safe cron re-entrancy** — `lib/advisoryLock.js`
   gained `tryWithAdvisoryLock` (namespace **1005** — see that file's own
   namespace registry), a non-blocking `pg_try_advisory_lock`-based variant
   of the existing `withAdvisoryLock`. This REPLACES the plain in-process
   JS booleans both scheduled QB sync jobs previously used
   (`lib/qbInboundSync.js`'s `_syncing`, `server.js`'s `_estimateSyncRunning`)
   — a session-level Postgres advisory lock is held per CONNECTION, so two
   different connections racing for the same key behave identically whether
   they come from the same process or two separate Railway
   replicas/processes, which a JS boolean never did. `qb-inbound-reconcile`
   and `qb-estimate-sync` use independent keys under the same namespace —
   they can still run concurrently with EACH OTHER (the shared breaker is
   what prevents them from jointly overwhelming Intuit, not this lock); each
   can simply no longer overlap with ANOTHER instance of itself.

**Full data-call-path audit (done as a precondition for merging the Phase 4
PR, not left to chance)**: every QuickBooks data call in this codebase was
confirmed to funnel through the one canonical `qbTokenManager.qbApiRequest`
— `server.js`'s `qbFetch`/`qbQuery`, `lib/qbInboundSync.js`'s `qbQuery`,
`lib/qbSyncTrigger.js`, `lib/qbEstimateInvoice.js`, and every PDF route —
which means the breaker gate protects ALL of them UNIVERSALLY, by
construction, regardless of which specific loop calls it: once open, every
call anywhere in the codebase becomes a free, zero-network-traffic
synthetic failure. This audit found a fifth unpaced, breaker-blind loop
that the first Phase 4 pass missed: `lib/qbSyncTrigger.js#runQbEstimateSyncAsync`
(the webhook-triggered, near-real-time sync — bounded to estimates updated
in the last 24h) had the SAME zero-pacing, no-circuit-detection customer-fetch
loop as the three already fixed, plus its OWN separate in-process `_syncing`
boolean. Fixed identically: paced (~150ms), stops early on a `circuitOpen`
skip, and its re-entrancy guard was upgraded to the same cross-process
`tryWithAdvisoryLock` (namespace 1005, key `qb-webhook-sync` — distinct from
`qb-inbound-reconcile`/`qb-estimate-sync`, so it can still run alongside
them). The remaining QB-calling loops in the codebase
(`routes/leadQB.js`'s manual, admin-triggered, single-lead-scoped
sync-estimates route — its sub-customer and full-QB-estimate-scan loops;
`lib/qbEstimateInvoice.js`'s per-deal estimate/invoice creation) are
single-call or naturally small-volume operations (the full-scan loop
specifically pre-filters by name/email before ever calling the API for a
candidate, "to avoid fetching customers for all 100+ estimates" per its own
comment) — none of them iterate over the WHOLE installation's customers/
estimates the way the four fixed loops do, and all of them are still
unconditionally covered by the same universal breaker gate regardless.
Conclusion: no QuickBooks data-call path in this codebase can generate
real outbound request volume once the breaker is open — the four
previously-unpaced bulk loops were a pacing/early-exit EFFICIENCY fix (fewer
retries spent reaching that point), not the only thing standing between a
sustained condition and continued hammering; the breaker itself is the
actual safety net, and it is structurally universal.
Regression coverage: `test/qbSyncTrigger.test.js` (the new pacing, the
`circuit_open`-stops-the-loop-early test, and the cross-process lock —
same fake-pool convention as `test/qbInboundSync.test.js`).

**System Health now surfaces the breaker's own state**
(`lib/systemHealthChecks.js#checkQuickBooks`): a new, always-present
`circuit_breaker` field (`state`/`consecutive_failures`/`opens_count`/
`cooldown_until` — never a request body, customer id, or amount) is
returned regardless of `verify` (a cheap, read-only `app_settings` SELECT).
When `verify=1` is requested WHILE the breaker is open and still cooling
down, `checkQuickBooks` reports `DEGRADED` directly
(`liveCheck(false, true, 'QuickBooks API rate-limited — circuit breaker
open until ...')`) WITHOUT calling `qbTokenManager.verifyConnection()` at
all — this avoids spending an admin's manual System Health check as yet
another doomed call, and avoids consuming the breaker's one precious
half-open trial slot on a page load rather than real production traffic.
Once the cooldown has elapsed, `checkQuickBooks` proceeds to the real
verify call as normal, which doubles as (and correctly reports the outcome
of) the breaker's own recovery trial. **This never masks a genuinely
revoked credential**: `qbTokenManager.verifyConnection`'s `reconnectRequired`
case reports `degraded: false` (not `true`), which still falls through to
`DISCONNECTED` under the Phase 3 `deriveState` fix — confirmed by a
dedicated test asserting a revoked credential is never reported as
`DEGRADED` even while the breaker is closed.

**Not verifiable from this environment** (no Railway/Intuit production
access here): whether this fix resolves the live "almost every second"
log pattern once deployed, and whether this installation's QB proxy server
actually runs more than one Railway replica (making the cross-process
locking fix load-bearing in production today, rather than purely
defense-in-depth for a future scale-out). Confirming System Health's new
`circuit_breaker` field transitions `closed` → `open` → `half_open` →
`closed` correctly during a real incident, and that the "almost every
second" log pattern stops recurring, is the remaining operator
verification step.

Regression coverage: `test/qbRateLimitBreaker.test.js` (pure unit — the
cooldown formula) + `test/integration/qbRateLimitBreaker.int.test.js`
(real-Postgres — the full closed/open/half-open state machine, concurrent
trial-slot exclusivity, doubled/capped cooldown growth, half-open
self-recovery); `test/qbTokenManager.test.js` (the breaker gating wired
into `qbApiRequest` — open skips the network call entirely, closed
proceeds and reports success, a terminal failure reports exactly once
(never per-attempt), an isolated retried blip never counts as a failure, a
breaker-check error fails open); `test/qbInboundSync.test.js` (stops early
on a mid-loop `circuit_open`, the cross-process lock skip);
`test/advisoryLock.test.js` (`tryWithAdvisoryLock`'s acquire/skip/release/
throw-still-releases behavior, independent keys never cross-coupling);
`test/qbEstimateSyncCapacity.test.js` (the re-entrancy guard assertion
updated from the old boolean to the new advisory lock);
`test/systemHealthChecks.test.js` (breaker-open-cooling-down skips the live
call and reports DEGRADED; an elapsed cooldown lets the trial call through;
a revoked credential is never masked; `circuit_breaker` is surfaced even
without `verify`; a breaker-read failure degrades gracefully).

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
