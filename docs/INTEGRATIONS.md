# Integrations — EC Construction Group CRM

## QuickBooks

### Architecture

```
QuickBooks API
  → Webhook (routes/qbWebhook.js)
  → qb_invoices_cache + qb_payments_cache + qb_invoice_sale_map
  → 15-minute node-cron reconciliation (server.js)
  → Deal Financial API (routes/dealFinancials.js)
  → CRM Frontend
```

- **Backend**: Railway/GitHub (qb-proxy-server)
- **Token storage**: `integration_credentials` table (AES-256-CBC encrypted)
- **Reconciliation**: Railway node-cron `*/15 * * * *`
- **No Base44 runtime** — zero Base44 scheduling, zero Base44 functions

### Endpoints

- `POST /api/v1/qb/webhook` — QuickBooks webhook receiver
- `POST /api/v1/cron/qb-inbound-reconcile` — Scheduled reconciliation
- `GET /api/v1/deals/:id/financials?sale_total=<n>` — Sale-scoped financials
- `POST /api/v1/sale-invoices/map` — Persist sale→invoice mapping

## Google Calendar

- **Connector**: Google Calendar (OAuth, supports webhooks)
- **Backend**: Railway service account (server-side event creation)
- **No browser-side Google Calendar OAuth**

## Gmail

- **Backend**: Railway-owned Gmail API (server-side)
- **Token storage**: `integration_credentials` table
- **No browser-side Gmail OAuth for sending**

## SignNow

- **Backend**: Railway (routes/signnow.js, routes/signnowWebhook.js)
- **Client credentials**: SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET

## HubSpot

- **Backend**: Railway (legacy sync, HUBSPOT_API_KEY)

## Google Contacts

- **Backend**: Railway service account (server-side contact sync)

## Handoff

- **Backend**: Railway (routes/handoffSync.js, routes/handoffEstimates.js)
- **Auth**: HANDOFF_AUTH_TOKEN

## Base44 Participation

**ZERO** — All integrations run entirely on Railway/GitHub.