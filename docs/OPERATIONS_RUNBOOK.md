# Operations Runbook — EC Construction Group CRM

**Last verified**: 2026-09-14

## CRM Does Not Load

1. Check Railway frontend service (insightful-encouragement) status
2. Check backend health: curl https://qb-proxy-server-production.up.railway.app/health
3. If backend down -> see "Backend is Down"
4. If backend up -> check frontend nginx logs
5. Check DNS: crm.ecconstructiongroup.com -> Railway frontend
6. Service worker: auto-updates on new deploy (build hash injection). If stuck, wait for auto-reload.

## Backend is Down

1. Check Railway service: qb-proxy-server
2. Check deployment logs for startup errors
3. Common causes:
   - Migration failure -> check db/migrate.js output
   - Pool exhaustion -> see "DB Pool is Exhausted"
   - Missing env var -> check Railway variables
4. Restart: Railway dashboard -> qb-proxy-server -> Restart
5. If crash loop -> check logs for MODULE_NOT_FOUND or syntax errors

## DB is Unavailable

1. Check Railway Postgres service status
2. Check connection: backend health endpoint (includes DB check)
3. If Postgres is down -> Railway dashboard -> Postgres -> Restart
4. If data corruption -> restore from backup (see DISASTER_RECOVERY.md)

## DB Pool is Exhausted

**Symptoms**: 502/504 errors, connection timeouts, "too many connections"

1. Check pool config: connectionTimeoutMillis=5000, statement_timeout=10s, idle_in_transaction_session_timeout=30s
2. Look for leaked connections: grep for pool.connect() without finally { client.release() }
3. Check for long-running queries: SELECT * FROM pg_stat_activity WHERE state = 'active' AND query_start < now() - interval '30 seconds'
4. Restart backend service (releases all connections)
5. If recurring -> audit new code for missing finally blocks

## Login Fails

1. Check backend health
2. Check auth endpoint: POST /api/v1/auth/login
3. If 401 -> check credentials
4. If 500 -> check JWT_SECRET env var
5. If Google SSO fails -> check Google OAuth config (redirect URI, client ID)
6. If "user_not_registered" -> check user_allowlist table

## Calendar Stops Syncing

1. Check calendar-outbox-worker (noble-illumination) service status
2. Check calendar_outbox table for stuck items: POST /api/v1/cron/diagnose-calendar-outbox
3. If stuck -> POST /api/v1/cron/reset-calendar-outbox-stuck
4. If backlog -> POST /api/v1/cron/drain-calendar-outbox
5. Check Google Calendar OAuth token: integration_credentials table
6. If token expired -> re-authenticate via /internal/gmail/oauth (Google Calendar shares Google OAuth)

## Reminders Stop

1. Check reminder-worker (artistic-determination) service status
2. Check REMINDER_DRY_RUN env var — must be 'false' for production sending
3. Run diagnostic: POST /api/v1/cron/diagnose-reminder-delivery
4. Check reminder claims: SmsReminder table for pending items
5. Run engine: POST /api/v1/cron/run-reminder-engine
6. Check Gmail OAuth token: integration_credentials table
7. If token expired -> re-authenticate

## Integration Auth Expires

### QuickBooks
1. Check integration_credentials table for qb token
2. If expired -> redirect user to /api/v1/qb/auth
3. Token auto-refreshes on API calls (markUsed)

### Google (Calendar/Contacts/Gmail)
1. Check integration_credentials table for google token
2. If expired -> re-authenticate via /internal/gmail/oauth
3. Service account (Maps) uses GOOGLE_SERVICE_ACCOUNT_KEY — check key validity

### SignNow
1. Check SIGNNOW_CLIENT_ID and SIGNNOW_CLIENT_SECRET env vars
2. Re-authenticate via SignNow OAuth flow

## Deployment Fails

1. Check Railway build logs
2. Check Dockerfile syntax
3. Check watch paths (railway.json) — only changed paths trigger deploy
4. If migration fails -> check db/migrations/*.sql syntax
5. If Docker cache stale -> Railway dashboard -> Redeploy with "Clear Build Cache"
6. Rollback: Railway dashboard -> previous deployment -> Deploy

## Monitoring

- **Watchdog**: POST /api/v1/cron/diagnose-watchdog (x-worker-secret)
- **Health**: GET /health (public)
- **System reconciliation**: POST /api/v1/cron/system-wide-reconciliation (x-worker-secret)
- **Incident table**: monitoring_incidents (viewable in CRM admin)
