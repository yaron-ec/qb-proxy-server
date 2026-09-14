# Production Architecture — EC Construction Group CRM

**Last verified**: 2026-09-14
**Repository**: yaron-ec/qb-proxy-server (branch: main, HEAD: 588ca8c)
**Railway Project**: devoted-courtesy

## Services

| Service | Railway Name | Purpose | Source | Dockerfile | Start Command |
|---------|-------------|---------|--------|------------|---------------|
| qb-proxy-server | qb-proxy-server-production | Backend API (Express) | Repo root | Dockerfile | sh -c 'node db/migrate.js && node server.js' |
| insightful-encouragement | Frontend CRM SPA | Frontend | crm-frontend/ | Dockerfile.frontend | nginx (serves dist/) |
| artistic-determination | Reminder Worker | Appointment reminders | Repo root | Dockerfile.worker | node reminderWorker.js |
| noble-illumination | Calendar Outbox Worker | Google Calendar sync | Repo root | Dockerfile.worker | node scripts/calendarOutboxWorker.js |
| Postgres | Railway Postgres | Database | Managed | N/A | N/A |

## Domains

- **Frontend**: crm.ecconstructiongroup.com (CNAME to Railway frontend service)
- **Backend API**: https://qb-proxy-server-production.up.railway.app
- **Frontend API config**: VITE_RAILWAY_API_URL = https://qb-proxy-server-production.up.railway.app

## Repository Structure

```
yaron-ec/qb-proxy-server (main)
+- server.js                 # Express API entrypoint
+- reminderWorker.js         # Reminder worker (Railway Cron, 30-min)
+- scripts/calendarOutboxWorker.js  # Calendar outbox worker
+- productionWatchdog.js     # Monitoring (not a separate service)
+- Dockerfile                # Backend
+- Dockerfile.worker         # Workers
+- Dockerfile.frontend       # Frontend build
+- railway.json              # Railway service definitions + watch paths
+- db/                       # Migrations + client
+- lib/                      # Business logic
+- routes/                   # Express routes
+- crm-frontend/             # Frontend SPA (Vite + React)
+- test/                     # Automated test suite (42 files)
```

## Data Flow

1. **Lead Capture**: Public form -> POST /api/public/capture -> bookingService.createBooking (atomic PG transaction) -> leads + appointments tables
2. **CRM UI**: Browser -> Railway frontend (nginx) -> Railway backend API -> Postgres
3. **Reminders**: Railway Cron (30 min) -> reminderWorker.js -> query due reminders -> Gmail API -> customer email
4. **Calendar Sync**: Appointment create/update -> calendar_outbox table -> calendarOutboxWorker.js -> Google Calendar API
5. **QuickBooks**: OAuth -> token store (integration_credentials) -> QB API -> estimates/invoices -> webhook -> CRM
6. **Handoff**: Handoff -> QuickBooks estimate -> qb-webhook -> CRM handoff_estimates table
7. **SignNow**: CRM -> SignNow API -> template copy -> send -> webhook -> signed document -> lead attachment

## Authentication

- **CRM users**: Railway JWT (access + refresh tokens), Google SSO + email/password
- **Worker endpoints**: WORKER_SECRET header (x-worker-secret)
- **Public capture**: No auth, rate-limited
- **Webhooks**: Provider-specific signatures (QB, SignNow, Meta)

## Watch Paths (railway.json)

- **qb-proxy-server**: server.js, lib/**, routes/**, db/**, scripts/**, package.json
- **reminder-worker**: reminderWorker.js, lib/reminder*.js, lib/crmRepository.js, lib/emailService.js, db/**
- **calendar-outbox-worker**: scripts/calendarOutboxWorker.js, lib/booking/**, lib/googleCalendarClient.js, db/**
- **production-watchdog**: productionWatchdog.js, lib/monitoring/**, db/**

## Zero-Base44 Verification

- GitHub code search for "base44": **0 results**
- @base44 imports: **0**
- @base44/sdk in package.json: **not present**
- @base44/vite-plugin in vite.config.js: **not present** (only comments mention "Zero Base44")
- 10 deleted Base44 files: **all confirmed absent**
- BASE44_ADMIN_EMAIL env var: **0 code references** (obsolete, safe to remove from Railway)
