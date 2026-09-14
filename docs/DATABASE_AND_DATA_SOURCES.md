# Database and Data Sources — EC Construction Group CRM

## Database

**Railway-managed PostgreSQL** — single instance, 5-service topology.

### Connection

- Host: Railway internal (`.up.railway.app`)
- Pool: `pg` with statement_timeout=10s (exempt for ensureSchema)
- SSL: required
- Migrations: `db/migrate.js` (idempotent, advisory-locked)

### Schema Management

- 36 migration files (2026-07 through 2026-37)
- `schema_migrations` table tracks applied migrations
- `db/migrate.js` runs on container startup (Dockerfile CMD)
- All migrations are idempotent (CREATE IF NOT EXISTS / DO $$)

## Key Tables

### CRM Core

| Table | Purpose |
|-------|---------|
| `leads` | Canonical lead records (Railway UUID PK, external_ref for Base44 compat) |
| `deals` | Sales/deals (Railway UUID PK, lead_id FK to leads) |
| `invoices` | Local invoice records (legacy, pre-QB) |
| `estimates` | Estimate records |
| `activities` | Activity feed (notes, calls, emails, meetings, tasks) |
| `tasks` | Task records |
| `appointments` | Booking records (busy_range EXCLUDE constraint) |
| `appointment_types` | Appointment type definitions |
| `owners` | Owner directory |

### QuickBooks Financial

| Table | Purpose |
|-------|---------|
| `qb_invoices_cache` | Cached mirror of QB invoice financials (TotalAmt, Balance, paid) |
| `qb_invoice_sale_map` | Durable sale→invoice ownership (qb_invoice_id → crm_sale_id) |
| `qb_payments_cache` | Cached QB payments (audit/detail data, NOT summed into paid totals) |
| `qb_payment_allocations` | Payment → Invoice → Deal allocation tracking |

### Settings

| Table | Purpose |
|-------|---------|
| `app_settings` | KV table (key, value JSONB). Canonical source for app_lists. |
| `settings` | Legacy singleton (id=1). NOT the source of truth for app lists. |

### Auth

| Table | Purpose |
|-------|---------|
| `users` | Railway auth users (email, password_hash, role, google_sub) |
| `user_allowlist` | Email allowlist for sign-in |

### Integrations

| Table | Purpose |
|-------|---------|
| `integration_credentials` | OAuth tokens (QuickBooks, Gmail) — AES-256-CBC encrypted |
| `gmail_oauth_states` | Gmail OAuth state tokens |
| `signnow_documents` | SignNow document tracking |
| `calendar_outbox` | Google Calendar sync outbox |

## Data Source Rules

### Lead Sources

- **Canonical source**: `app_settings` WHERE `key = 'app_lists'`, `value.sources` (camelCase)
- **NOT**: `settings.app_lists.lead_sources` (legacy, snake_case)
- All consumers read from the canonical source

### QuickBooks Financials

- **Authoritative**: QuickBooks API (TotalAmt, Balance)
- **Cached in**: `qb_invoices_cache` (paid = TotalAmt - Balance)
- **Mapped to deals**: `qb_invoice_sale_map` (qb_invoice_id → crm_sale_id)
- **No customer-level aggregation** for sale-scoped financials
- **No double counting** — payments are audit/detail, not summed into paid

### Deal Financials

- **PROJECT TOTAL**: `deals.amount` (CRM contract amount, never derived from QB)
- **INVOICED**: SUM of mapped, active, non-voided `qb_invoices_cache.total_amt`
- **PAID**: SUM of mapped `qb_invoices_cache.paid` (TotalAmt - Balance)
- **BALANCE**: INVOICED - PAID
- **REMAINING**: PROJECT TOTAL - PAID