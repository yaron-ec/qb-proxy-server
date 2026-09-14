# Database and Data Sources — EC Construction Group CRM

**Last verified**: 2026-09-14
**Database**: Railway Postgres (devoted-courtesy project)

## Connection Pool Configuration (db/client.js)

| Setting | Value | Purpose |
|---------|-------|---------|
| connectionTimeoutMillis | 5000 (5s) | Fail fast on connection issues |
| statement_timeout | 10s | Kill long-running queries |
| idle_in_transaction_session_timeout | 30s | Kill leaked transactions |
| pool.on(error) | Yes | Log pool-level errors |
| finally { client.release() } | Yes | Guaranteed connection return |

## Primary Tables

### ACTIVE (runtime read/write)

| Table | Purpose | Row Count |
|-------|---------|----------|
| leads | Lead records | 1083 |
| appointments | Appointment scheduling | 1509 |
| activities | Activity log | 5963 |
| deals | Deal/sale records | 46 |
| deal_expenses | Project expenses | 35 |
| deal_expense_payments | Expense payment tracking | - |
| deal_commissions | Commission tracking | - |
| deal_loan_payments | Loan payment tracking | - |
| invoices | Invoice records | - |
| estimates | Estimate records | 191 |
| handoff_estimates | QB estimate sync | 175 |
| lead_submissions | Form submission history | 3 |
| lead_attachments | File attachments | 8 |
| signnow_documents | SignNow document tracking | 10 |
| tasks | Task tracking | 1 |
| owners | Sales rep/owner directory | 12 |
| users | Auth users (Railway JWT) | - |
| app_settings | KV settings store (canonical) | - |
| company_settings | Company info | 1 |
| user_allowlist | Access control list | 4 |
| sync_cursors | Integration sync state | 5 |
| integration_credentials | OAuth tokens (encrypted) | - |

### QUEUE/OUTBOX

| Table | Purpose |
|-------|---------|
| calendar_outbox | Calendar sync queue (drained by calendarOutboxWorker) |
| calendar_sync_queue | Legacy calendar sync queue |

### AUDIT/MONITORING

| Table | Purpose |
|-------|---------|
| monitoring_health_checks | Health check history |
| monitoring_incidents | Incident records |
| monitoring_known_good | Known-good baseline state |
| schema_migrations | Migration tracking |
| appointment_events | Appointment audit log |

### HISTORICAL (safe to retain)

| Table | Purpose |
|-------|---------|
| settings | Legacy singleton settings (id=1, app_lists JSONB) — NOT runtime source |

## Canonical Settings Source

**app_settings** KV table is the canonical source for application lists.

```sql
SELECT value FROM app_settings WHERE key = 'app_lists'
```

**JSON structure** (camelCase):
```json
{
  "statuses": [...],
  "projectTypes": [...],
  "sources": [...],
  "contactOwners": [...]
}
```

**Consumers**: routes/leads.js GET /by-external/:externalRef/detail

**Legacy**: settings.app_lists (singleton, snake_case) is NOT the runtime source. Retained for historical recovery only.

## Canonical Lead Sources

```
["Sharon", "Yair", "Yelp", "Instagram / Facebook", "Referral", "Repeat customer", "Ethan", "Website", "Other"]
```

**Status**: Migration 2026-36-restore-lead-sources.sql pushed to repo (commit 588ca8c) but NOT YET applied — Docker layer cache served stale image (35/36 migrations). Railway redeploy with cache clear required.

## Migration System

- **Runner**: db/migrate.js (idempotent, advisory lock, checksum-tracked)
- **Location**: db/migrations/*.sql (36 files in repo, 35 in running container)
- **Execution**: Container startup 'node db/migrate.js && node server.js'
- **Manual trigger**: POST /api/v1/cron/apply-migrations (x-worker-secret)

## Integration State

| Integration | Token Storage | Sync Cursor | Status |
|-------------|--------------|-------------|--------|
| QuickBooks | integration_credentials (AES-256) | sync_cursors | Connected |
| Gmail | integration_credentials | N/A | Connected (reminder worker) |
| Google Calendar | integration_credentials | sync_cursors | Connected (outbox worker) |
| Google Contacts | integration_credentials | sync_cursors | Connected |
| SignNow | integration_credentials | N/A | Connected |
| Handoff | N/A (token-based) | N/A | NOT connected (no stored credential) |
| HubSpot | HUBSPOT_API_KEY env | sync_cursors | Configured |
