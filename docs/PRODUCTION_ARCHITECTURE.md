# Production Architecture — EC Construction Group CRM

## System Overview

The CRM is a full-stack application running entirely on Railway/GitHub with ZERO Base44 runtime dependency.

### Architecture Diagram

```
QuickBooks → Webhook → Railway/GitHub (qb-proxy-server) → Railway Postgres
                                ↓
                    15-minute node-cron reconciliation
                                ↓
                    qb_invoices_cache + qb_invoice_sale_map
                                ↓
                    Deal Financial API (sale-scoped)
                                ↓
                    CRM Frontend (crm-frontend/)
```

### Railway Services (5 — approved topology)

1. **qb-proxy-server** — Main CRM API server (Express.js, Node.js)
   - Serves all /api/v1/* authenticated endpoints
   - Serves /api/public/capture/* public endpoints
   - Runs node-cron for QB inbound reconciliation (every 15 min)
   - Runs node-cron for QB estimate sync
2. **insightful-encouragement** — Worker service
3. **artistic-determination** — Worker service
4. **noble-illumination** — Worker service
5. **Postgres** — Railway-managed PostgreSQL database

### Frontend

- **crm-frontend/** — Standalone Vite + React build (zero Base44)
- Published at: https://crm-ec-construction-group.base44.app
- Build mode: `vite build --mode exit` (loads .env.exit)
- No @base44/vite-plugin, no @base44/sdk, no Base44 stubs

### Authentication

- Railway-owned JWT (access + refresh tokens)
- Google SSO + email/password
- NO Base44 auth dependency
- RBAC: admin, manager, sales_rep, office roles

### Base44 Participation

**ZERO** — Base44 is not required for:
- Auth, Leads, Deals, Calendar, Reminders, QuickBooks, SignNow, Handoff, Capture/New Lead

## QuickBooks Inbound Sync

### Flow

```
QuickBooks Invoice
  → qb_invoices_cache (cached mirror of QB financials)
  → qb_invoice_sale_map (durable sale→invoice ownership)
  → Deal (crm_sale_id)
  → GET /api/v1/deals/:id/financials?sale_total=<amount>
  → computeSaleFinancials()
  → Deal Financial frontend
```

### Financial Formulas

- **PROJECT TOTAL** = Deal.amount (CRM contract/sale amount)
- **INVOICED** = SUM(invoice.total_amt) for mapped, active, non-voided invoices
- **PAID** = SUM(invoice.paid) where paid = TotalAmt - Balance (QB-authoritative)
- **BALANCE** = INVOICED - PAID (unpaid portion of what's been billed)
- **REMAINING** = PROJECT TOTAL - PAID (total left to collect on the project)
- **"Paid in full"** = TRUE only when PROJECT TOTAL > 0 AND REMAINING === 0

### Reconciliation

- **Trigger**: Railway node-cron `*/15 * * * *` in qb-proxy-server
- **Endpoint**: POST /api/v1/cron/qb-inbound-reconcile (WORKER_SECRET auth)
- **No Base44 scheduling** — Railway is the sole trigger
- **Idempotent** — QB entity IDs are idempotency keys

## Lead Sources

### Canonical Source of Truth

```
app_settings
  key = 'app_lists'
  value.sources (camelCase)
```

### Canonical Values

1. Sharon
2. Yair
3. Yelp
4. Instagram / Facebook
5. Referral
6. Repeat customer
7. Ethan
8. Website
9. Other

### Identity Rule

**Yair is a Lead Provider / Lead Source ONLY.**
Yair is NOT a CRM user, owner, or admin. Do NOT create, search, modify, or map any user/owner/auth record for Yair.

### Consumers

All production consumers read from `app_settings.value.sources`:
- Lead Detail (GET /api/v1/leads/:id/detail → leadSources)
- Capture/New Lead (GET /api/public/capture/app-lists → leadSources)
- No hardcoded arrays, no legacy settings.app_lists.lead_sources