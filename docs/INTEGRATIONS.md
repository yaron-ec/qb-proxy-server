# Integrations — EC Construction Group CRM

**Last verified**: 2026-09-14

## Google Calendar

- **Purpose**: Appointment sync (CRM -> Google Calendar)
- **Auth**: OAuth stored in integration_credentials (encrypted)
- **Path**: Appointment create/update -> calendar_outbox table -> calendarOutboxWorker.js -> Google Calendar API
- **Duplicate prevention**: Outbox queue with idempotency keys
- **Availability**: Google Calendar events participate in slot blocking via googleAvailability.js
- **Status**: Connected (watchdog: healthy)

## Gmail / Reminders

- **Purpose**: Send appointment reminder emails to customers
- **Auth**: OAuth stored in integration_credentials (encrypted)
- **Path**: Railway Cron (30 min) -> reminderWorker.js -> query due reminders -> Gmail API
- **Reminder types**: 12h, 2h, 30min before appointment
- **REMINDER_DRY_RUN**: Defaults to 'true' in code. Railway env var must be set to 'false' for production sending.
- **Idempotency**: appointment_key composite key prevents duplicate sends
- **Sales rep copy**: Rep receives a copy of customer reminder
- **Status**: Connected (watchdog: healthy)

## Google Maps

- **Purpose**: Geocoding (address -> coordinates) and routing (travel duration/distance)
- **Auth**: GOOGLE_SERVICE_ACCOUNT_KEY (service account JSON)
- **Path**: DailyMap routing -> googleMapsClient.js -> Google Maps API
- **Timeout**: Bounded HTTP timeout, errors handled gracefully
- **DB safety**: Geocoding moved OUTSIDE DB transactions (commit 469cfee)
- **Status**: Connected

## Google Contacts

- **Purpose**: Sync leads to Google Contacts (multi-account: rep, Michelle, Yaron)
- **Auth**: OAuth stored in integration_credentials
- **Path**: Lead create/update -> googleContactsClient.js -> Google Contacts API
- **updatePersonFields**: Configured for relevant contact fields
- **Multi-account**: google_contact_recipients array tracks per-account sync
- **Status**: Connected

## QuickBooks

- **Purpose**: Customer/estimate/invoice sync
- **Auth**: OAuth stored in integration_credentials (AES-256-CBC, key versioning)
- **Company**: EC Construction Group
- **Paths**:
  - Lead -> QB customer (qb_customer_id mapping)
  - QB estimate -> handoff_estimates table (via webhook)
  - Deal -> QB invoice (invoice sync)
  - Payment tracking (qb_payment_status, qb_balance_due)
- **Webhook**: /api/v1/qb-webhook (QuickBooks -> CRM)
- **Scheduler**: scheduleQBEstimateSync
- **Token refresh**: Automatic, markUsed() on successful API calls
- **Status**: Connected (watchdog: healthy)

## Handoff

- **Purpose**: Import estimates from Handoff (construction management tool)
- **Architecture**: Handoff -> QuickBooks estimate -> QB webhook -> CRM
- **Auth**: HANDOFF_AUTH_TOKEN (token-based, not OAuth)
- **Current state**: NOT connected (no stored credential — watchdog: unhealthy)
- **Note**: Direct Handoff API dependency is NOT the production source. QB webhook is the canonical path.
- **Status**: Disconnected (by design — QB is the intermediary)

## SignNow

- **Purpose**: Electronic signature for contracts
- **Auth**: OAuth (SIGNNOW_CLIENT_ID + SIGNNOW_CLIENT_SECRET)
- **Path**: CRM -> SignNow API -> copy template -> populate lead data -> send -> webhook -> signed doc
- **Template architecture**: Copy-from-template (original template remains untouched)
- **Document naming**: Automatic, lead-specific
- **Webhook**: /api/v1/signnow-webhook (idempotent)
- **Signed document**: Attached to lead as attachment + activity logged
- **Status**: Connected (watchdog: healthy)

## HubSpot

- **Purpose**: Contact sync (CRM -> HubSpot)
- **Auth**: HUBSPOT_API_KEY (env var)
- **Path**: Lead create/update -> HubSpot API (if hubspot_sync_status != 'synced')
- **Delta detection**: hubspot_sync_hash for change detection
- **Status**: Configured
