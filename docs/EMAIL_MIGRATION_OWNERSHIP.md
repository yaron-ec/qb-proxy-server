# Email Migration — Ownership, Cutover Matrix, and Auth Stages

**Status: NOT approved for push. No deploy, no migration, no OAuth, no automation disablement, no real email.**

This document defines the migration ownership model (Approach A — no browser
delegation), the per-flow cutover matrix, and the two-stage authentication plan
required for complete Base44 backend disconnection.

---

## 1. Architecture: Approach A (no browser delegation)

The browser never decides which backend delivers an email and never performs a
Base44 call because Railway told it to. Each flow is owned by exactly ONE
backend, declared in `FLOW_OWNERSHIP` in `src/lib/emailTransport.js`.

- While a flow is `base44`: the UI calls the existing Base44 function directly
  (today's production behavior). The Railway route for that flow returns
  `421 Misdirected` and sends nothing.
- At cutover: the flow's owner flips to `railway` in `FLOW_OWNERSHIP` AND the
  matching Base44 trigger/automation is disabled in the same change.
- The browser never receives `delegate:true`. There is no runtime two-backend
  delegation protocol.

`transportControl.js` (Railway env `EMAIL_<FLOW>_TRANSPORT`) still exists to
gate the Railway cron worker and Railway-owned HTTP routes. It does NOT cause
the browser to delegate: when a Railway route sees `base44` it returns 421 and
the browser's `emailTransport.js` calls Base44 directly per `FLOW_OWNERSHIP`.

---

## 2. Per-flow ownership & cutover matrix

| Flow | Current owner | Current frontend trigger | Current backend executor | Future Railway trigger | Future Railway executor | Exact cutover action | Exact rollback action |
|---|---|---|---|---|---|---|---|
| GENERIC | base44 | `EmailPanel` compose → `sendGenericEmail` | Base44 `sendGmailEmail` | `sendGenericEmail` (railway) | Railway `POST /api/v1/emails/send` | flip `FLOW_OWNERSHIP.GENERIC='railway'`; verify Railway session; no Base44 trigger to disable (on-demand) | flip back to `'base44'` |
| INVOICE | base44 | **no visible UI trigger** (see §4) | Base44 `sendInvoiceEmail` | (future) invoice panel email button | Railway `POST /api/v1/invoices/:id/email` | add UI button wired to `sendInvoiceEmail` (railway); flip `FLOW_OWNERSHIP.INVOICE='railway'` | remove button / flip back |
| MANUAL_REMINDER | base44 | `AppointmentReminderPanel` → `sendManualReminder` | Base44 `sendManualReminder` | `sendManualReminder` (railway) | Railway `POST /api/v1/leads/:id/remind` | flip `FLOW_OWNERSHIP.MANUAL_REMINDER='railway'` | flip back |
| APPOINTMENT_REMINDER_PANEL | base44 | `AppointmentReminderPanel` per-recipient → `sendAppointmentReminder` | Base44 `sendGmailEmail` | same | Railway `POST /api/v1/emails/send` | flip `FLOW_OWNERSHIP.APPOINTMENT_REMINDER_PANEL='railway'` | flip back |
| SCHEDULED_REMINDER | base44 | (none — cron) | Base44 automation `sendAppointmentReminder` (every 30m) | Railway cron `reminderWorker.js` | Railway `reminderEngine.processReminders` | set `EMAIL_SCHEDULED_REMINDER_TRANSPORT=railway` + disable Base44 automation | set back to `base44` + re-enable Base44 automation |
| PHONE_CALL_REMINDER | base44 | (none — cron) | Base44 automation `sendPhoneCallReminders` (every 30m) | Railway cron | Railway `phoneCallReminders.processPhoneCallReminders` | set `EMAIL_PHONE_CALL_REMINDER_TRANSPORT=railway` + disable Base44 automation | set back to `base44` + re-enable Base44 automation |
| TASK_REMINDER | base44 | (none — cron) | Base44 automation `sendTaskReminders` (every 15m) | Railway cron | Railway `taskReminderEngine.processTaskReminders` | set `EMAIL_TASK_REMINDER_TRANSPORT=railway` + disable Base44 automation | set back to `base44` + re-enable Base44 automation |
| STATUS_NOTIFICATION | base44 | (status change) | Base44 `notifyStatusChange` | (future) | Railway | TBD | TBD |
| ACTIVITY_NOTIFICATION | base44 | (activity) | Base44 `notifyCRMActivity` | (future) | Railway | TBD | TBD |
| NEW_LEAD_NOTIFICATION | base44 | (new lead) | Base44 `sendNewLeadAlerts` / `notifyYaronNewWebsiteLead` | (future) | Railway | TBD | TBD |
| TEST | base44 | test panels | Base44 `sendGmailEmail` | test panels | Railway `POST /api/v1/emails/test` | flip `FLOW_OWNERSHIP.TEST='railway'` | flip back |

Cutover rules:
- The Base44 trigger remains unchanged until cutover.
- At cutover, only the matching Base44 trigger is disabled, the Railway flow
  is enabled, and the UI is rewired. Both are never callable from the visible
  UI simultaneously.
- Rollback reverses exactly the cutover steps.

---

## 3. Authentication stages

### Stage A — Temporary migration bridge (current)

- Route: `POST /api/v1/auth/migrate { base44_token }` (routes/auth.js).
- Verification: `lib/base44TokenVerify.verifyBase44Token(token)` calls Base44
  `/auth/me` with the token. Email + role come ONLY from Base44's verified
  response — never from the browser. A forged/expired/missing token is rejected
  by Base44 (401) and never produces a Railway identity.
- Session: short-lived Railway JWT (15 min access, 30-day rotating refresh).
- Existing Railway user: stored Railway role ALWAYS wins (no privilege
  escalation). Disabled users rejected.
- New user: role from the verified Base44 token only, defaulting to `user`.
- Replayable: yes, intentionally — re-provisioning is idempotent and issues a
  fresh session. Not a security risk (token must still verify each time).
- Base44 unavailable: safe failure (503), no fallback to a privileged session.
- Removal condition: delete `routes/auth.js` `/migrate` handler +
  `lib/base44TokenVerify.js` + `railwayApi.migrateFromBase44` in
  `src/lib/railwayApi.js` + the `ensureRailwaySession` bridge call in
  `src/lib/AuthContext.jsx`. Target files listed; nothing else depends on them.

### Stage B — Final independent Railway authentication (design; not yet active)

- Railway-owned user/session authentication. No Base44 token, no Base44 user
  lookup, no Base44 function execution.
- Primary login: passwordless email magic-link OR Google OIDC SSO (the
  `users.google_sub` column already exists; `authService.findOrCreateByGoogleSub`
  is implemented). Password (scrypt) remains a fallback.
- Railway-owned JWT issuance (`authService.issueSession`) + rotating refresh
  tokens (`authService.rotateRefreshToken`, single-use, SHA-256 hashed, stored
  in `refresh_tokens`).
- Railway-owned role + access checks (`rbac.js`, `authorization.js`).
- Stage B is NOT active. Do not claim full disconnection until Stage B is
  implemented and the Stage A bridge is removed.

---

## 4. Invoice UI trace (§9 of review)

- `src/components/InvoiceCreationFlow.jsx`: button "Create Invoice in
  QuickBooks" → `base44.functions.invoke("qbSync", {action:"sync_invoice"})`.
  No email action. No PDF email.
- `src/components/PartialInvoiceFlow.jsx`: balance KPI cards + editable
  project total. Imports `Mail`/`MailX`/`RotateCw` but they are NOT rendered.
  No email button.
- `src/components/PaymentPanel.jsx`: payment info edit form (invoice amount,
  deposit, payment received, method, date). No email button.
- `src/components/DealPaymentPanel.jsx`: payment milestones, mark-as-paid,
  note edit. No email button.
- `src/components/dealdetail/DocumentsTab.jsx`: SignNow contracts + file
  uploads. No email button.
- `src/components/EmailPanel.jsx`: generic lead email composer + "Load Emails
  from Gmail" via `railwayRequest('/gmail/fetch-emails')` (a Railway route,
  not a browser Gmail token).

**Conclusion: there is no visible "Email Invoice" / "Send Invoice" button in the
current UI. The Base44 `sendInvoiceEmail` function has no user-facing trigger.
No invoice-email path is migrated in this phase.**

---

## 5. Gmail read migration (§10)

- New routes: `GET /api/v1/gmail/profile`, `GET /api/v1/gmail/messages`,
  `GET /api/v1/gmail/messages/:id` (routes/gmail.js). All `requireAuth`.
- Gmail token obtained/refreshed server-side via `gmailSender.refreshAccessToken`.
- No Gmail access/refresh token, client id, or client secret is ever returned to
  the browser. Read-only; no send capability on these routes.
- `src/components/EmailSyncPanel.jsx` rewritten to use `railwayApi.gmailProfile/
  gmailMessages/gmailMessage`. No browser-side `Authorization: Bearer <gmail>`
  construction remains in that component.
- `EmailPanel.jsx` uses `railwayRequest('/gmail/fetch-emails')` (Railway route),
  not a browser Gmail token. (Pre-existing; verified not to expose tokens.)

---

## 6. What was NOT touched

QuickBooks sync, Handoff estimates, Google Calendar/Contacts, SignNow,
HubSpot, CRM entity records, Deals/financials, and all unrelated logic were
not modified. No Base44 automation was disabled. No real email was sent. No
OAuth was initiated. No migrations were run. No push/deploy/publish.