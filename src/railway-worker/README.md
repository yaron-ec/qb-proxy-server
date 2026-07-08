# Handoff RPA Worker

Playwright-based worker that logs into Handoff, captures all estimates via network interception, and imports them into ContractorFlow CRM via the `handoffBulkImport` Base44 backend function.

---

## Deploy to Railway

### 1. Create a new Railway project

- Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
- Select your repo
- Set **Root Directory** to `railway-worker`
- Railway will auto-detect the `Dockerfile` and build it

### 2. Set environment variables in Railway

| Variable | Value |
|---|---|
| `HANDOFF_EMAIL` | Your Handoff login email |
| `HANDOFF_PASSWORD` | Your Handoff login password |
| `HANDOFF_URL` | `https://app.handoff.com` (or your org URL) |
| `BASE44_IMPORT_URL` | Full URL to `handoffBulkImport` Base44 function (Base44 Dashboard → Code → Functions → handoffBulkImport) |
| `BASE44_REMINDER_URL` | Full URL to `sendAppointmentReminder` Base44 function (Base44 Dashboard → Code → Functions → sendAppointmentReminder) |
| `WORKER_SECRET` | Same value as `WORKER_SECRET` secret in Base44 |
| `PORT` | `3000` (Railway sets this automatically) |

### 3. Set secrets in Base44

In Base44 Dashboard → Settings → Secrets:

| Secret | Value |
|---|---|
| `RAILWAY_WORKER_URL` | Your Railway service public URL (e.g. `https://handoff-rpa-worker.railway.app`) |
| `WORKER_SECRET` | Same random string as Railway's `WORKER_SECRET` |

### 4. Trigger a run

Go to **Settings → Syncs → Handoff Import** in ContractorFlow and click **"Run Handoff Export Worker Now"**.

Or POST directly:
```bash
curl -X POST https://your-worker.railway.app/run \
  -H "x-worker-secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## How it works

1. Launches headless Chromium via Playwright
2. Logs into Handoff with your credentials
3. Navigates to the estimates list
4. Intercepts the API responses the page makes (GraphQL or REST) to capture estimate data
5. Falls back to DOM scraping if interception yields nothing
6. Imports each estimate into Base44 via `handoffBulkImport`
7. Saves a checkpoint after each estimate so it can resume if interrupted
8. Clears the checkpoint on full success

## Health check

```bash
curl https://your-worker.railway.app/health \
  -H "x-worker-secret: your-secret"
```

## Reset checkpoint (to re-import everything)

```bash
curl -X POST https://your-worker.railway.app/reset-checkpoint \
  -H "x-worker-secret: your-secret"
```

---

## Appointment Reminder Cron (zero Base44 credits)

The worker runs `sendAppointmentReminder` automatically **every 30 minutes** via an internal `setInterval` loop — no Base44 scheduled automations required.

### How it works

1. Railway service starts → waits 1 minute → fires first reminder run
2. Every 30 minutes after that, calls `BASE44_REMINDER_URL` with `x-worker-secret` header
3. `sendAppointmentReminder` runs: checks all leads, sends Gmail emails for any window (48h/24h/12h/2h/30min) that is due
4. Idempotency keys (`REMINDER_SENT:reminder:<lead_id>:<window>:<date>`) stored as Activity records prevent double-sends across runs
5. Gmail API called directly — **zero Base44 credits consumed**

### Manual trigger

```bash
curl -X POST https://your-worker.railway.app/remind \
  -H "x-worker-secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Verify it's working

Check Railway logs for lines like:
```
[reminders] Cron run complete: {"success":true,"sent_count":2,"skipped_count":0,...}
[reminder] ✉️ CLIENT → customer@gmail.com (Richard Luciano, 24h) id=19ed...
[reminder] ✉️ STAFF → yaron@ecconstructiongroup.com id=19ed...
``