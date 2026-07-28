# Apply Instructions — `reminder-action-changes.patch`

Apply from the **GitHub repository root** on branch `reminder-phase2-dryrun`.

> **Baseline assumption:** the patch's old side matches builder commit `96af70b` — the state where `lib/reminderEngine.js` exists and `lib/actionRouter.js` does **not** (your reported real-branch state). The action-path files are introduced as **new files**; only `db/schema.sql`, `lib/crmRepository.js`, `lib/leadIngest.js`, `lib/reminderEngine.js`, `lib/reminderTime.js` are *modifications* (they must match their `96af70b` versions on your branch). Default `git apply` (no `-p` flag) is used — no path stripping. If `git apply --check` fails, the branch differs from that baseline — stop and reconcile; do not force-apply.

## 1. Apply the patch

```
git fetch origin
git checkout reminder-phase2-dryrun
git pull --ff-only origin reminder-phase2-dryrun
git apply --check src/proxy-server/reminder-action-handoff/reminder-action-changes.patch
git apply src/proxy-server/reminder-action-handoff/reminder-action-changes.patch
git status
git diff --check
```

If `git apply --check` reports a mismatch against your branch state, do **not** proceed. Reconcile the branch to the `96af70b` baseline for the affected paths first, then re-run `--check`. The most likely failure source is one of the 5 *modified* files differing from its `96af70b` version.

## 2. Verify file integrity

Confirm the patch and docs were not altered in transit using `FILE_HASHES.txt`:

```
cd src/proxy-server/reminder-action-handoff
sha256sum reminder-action-changes.patch MANIFEST.md APPLY_INSTRUCTIONS.md
```

Compare against `FILE_HASHES.txt`. Any mismatch means the handoff was modified — do not apply.

## 3. Syntax-check changed JavaScript (from the repository root)

```
node --check src/proxy-server/lib/actionTokenStore.js
node --check src/proxy-server/lib/reminderNotifications.js
node --check src/proxy-server/lib/reminderActions.js
node --check src/proxy-server/lib/reminderPages.js
node --check src/proxy-server/lib/actionRouter.js
node --check src/proxy-server/lib/reminderTime.js
node --check src/proxy-server/lib/repDirectory.js
node --check src/proxy-server/lib/crmRepository.js
node --check src/proxy-server/lib/leadIngest.js
node --check src/proxy-server/lib/reminderEngine.js
node --check src/proxy-server/test/actionFlow.test.js
node --check src/proxy-server/test/railwayDryWalkthrough.js
```

All must report no output (success).

## 4. Confirm the action path is Base44-free

```
grep -REn "require\(['\"](\./)*base44['\"]\)|@base44/sdk|base44\.entities\." \
  src/proxy-server/lib/actionRouter.js \
  src/proxy-server/lib/actionTokenStore.js \
  src/proxy-server/lib/reminderActions.js \
  src/proxy-server/lib/reminderNotifications.js \
  src/proxy-server/lib/reminderPages.js \
  src/proxy-server/lib/repDirectory.js \
  src/proxy-server/lib/reminderTime.js
```

Expected: no matches.

## 5. Confirm `schema.sql` has no DROP / TRUNCATE

```
grep -REni "drop table|truncate|drop index|drop column|drop constraint" src/proxy-server/db/schema.sql
```

Expected: no matches.

## 6. Run the synthetic unit tests (from the proxy-server service root)

```
cd src/proxy-server
node test/actionFlow.test.js
```

Expected: `… checks passed.` and exit code 0.

## 7. Run the migration (from the proxy-server service root, on Railway)

Ensure the Railway variables in `MANIFEST.md` are set, then:

```
npm run reminders:migrate
```

## 8. Run the dry walkthrough (from the proxy-server service root, on Railway)

```
node test/railwayDryWalkthrough.js
```

Expected: `result: PASS`, exit code 0. Run **once**. Do not rerun on failure without review.

## Guardrails

- Do **not** push to `main`.
- Do **not** merge to `main`.
- Do **not** enable Gmail.
- Do **not** enable cron.
- Do **not** change `REMINDER_DRY_RUN` from `true`.
- Do **not** change production environment variables.
- If any assertion fails: do not rerun repeatedly, do not change production data, confirm cleanup completed, report the exact failed assertion, and stop for review.