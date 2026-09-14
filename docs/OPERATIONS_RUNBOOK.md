# Operations Runbook — EC Construction Group CRM

## Deployment

### Backend (qb-proxy-server)

1. Push to `main` branch on GitHub (yaron-ec/qb-proxy-server)
2. Railway auto-deploys from GitHub
3. Dockerfile runs `node db/migrate.js && node server.js`
4. Health check: `GET /health` → 200

### Frontend (crm-frontend)

1. Push to `main` branch on GitHub
2. Build: `vite build --mode exit` (loads .env.exit)
3. Deploy: Railway serves the built static files
4. Service worker auto-updates via build hash injection

## Health Checks

| Endpoint | Expected | Purpose |
|----------|----------|---------|
| `GET /health` | 200 | qb-proxy-server alive |
| `GET /api/public/capture/app-lists` | 200 + JSON | Canonical Lead Sources |
| `POST /api/v1/cron/qb-inbound-reconcile` | 200 + JSON | QB reconciliation |

## Common Operations

### Trigger QB Reconciliation Manually

```bash
curl -X POST https://qb-proxy-server-production.up.railway.app/api/v1/cron/qb-inbound-reconcile \
  -H "x-worker-secret: $WORKER_SECRET"
```

### Check Lead Sources

```bash
curl https://qb-proxy-server-production.up.railway.app/api/public/capture/app-lists
```

Expected: `{"leadSources":["Sharon","Yair","Yelp","Instagram / Facebook","Referral","Repeat customer","Ethan","Website","Other"],"projectTypes":[...]}`

### Check Deal Financials

```bash
curl -H "Authorization: Bearer <JWT>" \
  "https://qb-proxy-server-production.up.railway.app/api/v1/deals/<deal-id>/financials?sale_total=<amount>"
```

## Reminder Worker

- **REMINDER_DRY_RUN**: false (production sends real reminders)
- **Worker**: Railway service (insightful-encouragement or similar)
- **Do NOT restart** the reminder worker merely for verification

## Environment Variables

### Obsolete/Unused

- `BASE44_ADMIN_EMAIL` — 0 code references. Obsolete unused variable. Do NOT delete without explicit authorization.

### Active

- `WORKER_SECRET` — Cron endpoint authentication
- `RAILWAY_API_TOKEN` — Railway API access
- `QB_CLIENT_ID`, `QB_CLIENT_SECRET` — QuickBooks OAuth
- `SIGNNOW_CLIENT_ID`, `SIGNNOW_CLIENT_SECRET` — SignNow OAuth
- `GOOGLE_SERVICE_ACCOUNT_KEY` — Google Calendar/Contacts service account
- `HUBSPOT_API_KEY` — HubSpot API
- `HANDOFF_AUTH_TOKEN`, `HANDOFF_API_BASE_URL` — Handoff integration