# Reminder-Action Handoff — `reminder-phase2-dryrun`

**Baseline (patch old-side):** Base44 builder commit `96af70b` — the state that matches the real `reminder-phase2-dryrun` branch: `lib/reminderEngine.js` **present**, `lib/actionRouter.js` **absent**. This is the immediate parent of the builder commit that first introduced `actionRouter.js` (`d895ff9`), so the action-path files are introduced as **new files** (not modifications), which is what the real branch requires.
**Patch new-side (target):** builder commit `8ef9aef6bf18011ba96d11c21b780560c099819b` (`HEAD`).

> **Why the previous patch failed:** the first patch was diffed from `d895ff9`, where `actionRouter.js` already existed, so it tried to *modify* `actionRouter.js`. The real branch never received `actionRouter.js` (it lives only in the builder's internal store — see note below), so `git apply --check` failed. Diffing from `96af70b` makes `actionRouter.js` a **new-file** entry, which applies to a tree that lacks it.

> **Apply assumption:** this patch applies cleanly (default `git apply`, no `-p` flag) to a tree whose `src/proxy-server/` state matches builder commit `96af70b`. Verified: `git apply --check` + `git apply` against a clean `96af70b` worktree succeed, and every resulting file is byte-identical to `HEAD`. **This builder has no remote to your GitHub repo** (only Base44's internal S3 store, `main` only) and `reminder-phase2-dryrun` is not fetchable here, so final verification against your real branch must be run on your side. If any of the 5 *modified* files (`db/schema.sql`, `lib/crmRepository.js`, `lib/leadIngest.js`, `lib/reminderEngine.js`, `lib/reminderTime.js`) differ on your branch from their `96af70b` versions, `git apply --check` will name them — do not force-apply.

---

## Files in this handoff

### Added (A) — 8 files (new to the branch)
| Path | Description |
|---|---|
| `src/proxy-server/lib/actionRouter.js` | `/r/*` public routes: opaque-token resolution, expiry, appointment change-detection, one-time CSRF nonces, per-IP rate limit, strict security headers. **Two fixes:** (1) skip `flushPendingNotifications` when `REMINDER_DRY_RUN === "true"`; (2) reject notes longer than 500 characters with HTTP 400 instead of truncating. |
| `src/proxy-server/lib/actionTokenStore.js` | Opaque 32-byte action tokens; only SHA-256(rawToken) is stored; stable appointment fingerprint (lead_id + date + time + type + rep email). |
| `src/proxy-server/lib/reminderActions.js` | Atomic confirm/reschedule with `ON CONFLICT DO NOTHING` idempotency; one-time nonce issue/consume; no Base44. |
| `src/proxy-server/lib/reminderNotifications.js` | Internal notification queue (Railway Postgres). Confirm/reschedule enqueue a notification in the same transaction that commits the customer action; Gmail delivery is a separate, post-commit flush path that is **skipped when `REMINDER_DRY_RUN === "true"`**. |
| `src/proxy-server/lib/reminderPages.js` | Branded, mobile-friendly, WCAG-AA action pages rendered entirely from the stored token snapshot (never reads Base44). |
| `src/proxy-server/lib/repDirectory.js` | Rep contact directory; resolves `assigned_rep` to a contact card. |
| `src/proxy-server/test/actionFlow.test.js` | Synthetic action-flow unit tests (in-memory mock DB; no network, no email, no Base44). |
| `src/proxy-server/test/railwayDryWalkthrough.js` | Self-contained end-to-end dry walkthrough over real HTTP against the deployed `/r/*` routes; synthetic-only; redacts all tokens/PII; cleans up in a `finally`. |

### Modified (M) — 5 files (already present on the branch)
| Path | Description |
|---|---|
| `src/proxy-server/db/schema.sql` | Adds `reminder_action_tokens`, `reminder_actions`, `reminder_notifications`, `reminder_form_nonces`; adds representative-snapshot columns to `reminder_leads` (`assigned_rep_name/email/phone`); adds idempotency partial UNIQUE indexes. **No `DROP TABLE` / `TRUNCATE` / `DROP INDEX` / `DROP COLUMN` / `DROP CONSTRAINT`.** Idempotent (`CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). |
| `src/proxy-server/lib/crmRepository.js` | Lead-source switch (`REMINDER_SOURCE=postgres` / test / legacy). The legacy Base44 branch is **retained but dormant** — not invoked under `REMINDER_SOURCE=postgres`. Not part of the action path. |
| `src/proxy-server/lib/leadIngest.js` | Validation + idempotent upsert into `reminder_leads` with a representative snapshot captured at ingestion. |
| `src/proxy-server/lib/reminderEngine.js` | Reminder engine using Railway PostgreSQL atomic claims; dry-run mode honored. |
| `src/proxy-server/lib/reminderTime.js` | Pacific timezone + formatting helpers (ported verbatim from the Base44 sendAppointmentReminder path). |

### Deleted (D) — none

> **Note on `lib/reminderTokens.js`:** it is **not** in this patch and requires no deletion. `reminderTokens.js` existed only transiently *inside the builder* (added at builder commit `d895ff9`, removed at a later builder commit); it was never present at the `96af70b` baseline and never reached the real branch. The real branch does not contain it, so no `D` entry is needed (a delete hunk against a non-existent file would itself fail to apply). Its replacement is `actionTokenStore.js` (Added, above).

---

## Confirmations

- **No secrets included.** Secret scan of the patch found zero literal secret patterns (Bearer / AIza / xox / sk_ / ghp / `1/…` refresh tokens). Only the deliberately-invalid placeholder string `Zzz_rate_burst_invalid_xxx…` (in the walkthrough script) matched the long-literal heuristic — it is not a secret. All credentials are read from environment variables at runtime (`process.env.*`); no values are committed.
- **No raw action tokens included.** Tokens are generated at runtime via `crypto.randomBytes(32)`; no raw token is hardcoded, logged, or stored. The walkthrough script prints only `…redacted` excerpts.
- **`schema.sql` contains no `DROP` or `TRUNCATE`.** Verified: zero matches for `DROP TABLE`, `TRUNCATE`, `DROP INDEX`, `DROP COLUMN`, `DROP CONSTRAINT`.
- **The reminder action path has zero Base44 imports.** Verified across `actionRouter.js`, `actionTokenStore.js`, `reminderActions.js`, `reminderNotifications.js`, `reminderPages.js`, `repDirectory.js`, `reminderTime.js` — 0 imports of `./base44`, `@base44/sdk`, or any `base44.entities.*` call. (`crmRepository.js` retains the dormant legacy Base44 branch, reported here for transparency; it is outside the action path and is not invoked under `REMINDER_SOURCE=postgres`.)

## Syntax-check results (compile-only, `vm.Script`)

All changed JavaScript files compile cleanly:

| File | Result |
|---|---|
| `lib/actionTokenStore.js` | OK |
| `lib/reminderNotifications.js` | OK |
| `lib/reminderActions.js` | OK |
| `lib/reminderPages.js` | OK |
| `lib/actionRouter.js` | OK |
| `lib/reminderTime.js` | OK |
| `lib/repDirectory.js` | OK |
| `lib/crmRepository.js` | OK |
| `lib/leadIngest.js` | OK |
| `lib/reminderEngine.js` | OK |
| `test/actionFlow.test.js` | OK |
| `test/railwayDryWalkthrough.js` | OK |

## Required Railway service variables

```
REMINDER_DRY_RUN=true
REMINDER_SOURCE=postgres
REMINDER_PUBLIC_URL=https://qb-proxy-server-production-fc72.up.railway.app
REMINDER_ACTION_SECRET=<existing Railway secret>
DATABASE_URL=<existing Railway variable>
```

Gmail credentials (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN`) and the reminder cron are **not** required for this dry walkthrough and must remain disabled.

## Exact commands

Migration (idempotent; safe to re-run):
```
npm run reminders:migrate
```

Dry walkthrough (run once, from the proxy-server service root):
```
node test/railwayDryWalkthrough.js
```

Do not run the production start command. Do not enable Gmail or cron.