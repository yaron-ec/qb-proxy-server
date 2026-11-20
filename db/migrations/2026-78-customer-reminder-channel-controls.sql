-- CRM repair item 10 (November 2026): "Customer Reminders" previously only
-- ever gated EMAIL reminders (lib/reminderEngine.js's email loop,
-- lib/booking/bookingService.js#sendBookingConfirmationEmailBestEffort,
-- lib/phoneCallReminders.js) — SMS reminders (12h/2h window SMS, and the
-- booking-confirmation SMS) never checked `leads.customer_reminders_disabled`
-- at all, confirmed by direct code read of
-- lib/booking/bookingService.js#sendBookingConfirmationSmsBestEffort (checks
-- only `lead.sms_consent`) and lib/reminderEngine.js#sendWindowSms (checks
-- only the feature-activation flags). The existing Lead Detail UI text
-- ("Customer Reminders — Reminder emails enabled") was itself the honest
-- description of what the single existing toggle actually did — but the
-- business expectation was that disabling it stops BOTH channels.
--
-- `leads.customer_reminders_disabled` is kept, UNCHANGED in meaning and
-- every existing call site, as the MASTER control — disabling it already
-- stops email everywhere it was checked; this migration's job is only to
-- ALSO make it stop SMS (see lib/smsService.js#sendSms), and to add two
-- new, genuinely independent per-channel overrides:
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_email_reminders_disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_sms_reminders_disabled BOOLEAN NOT NULL DEFAULT false;

-- The appointment/phone-call reminder engines (lib/reminderEngine.js,
-- lib/phoneCallReminders.js) read from the DERIVED `reminder_leads`/
-- `test_leads` projection tables (lib/reminderProjection.js), never
-- `leads` directly — SMS reminders don't need this (lib/smsService.js's
-- central sendSms gate reads the live `leads` row directly), but the
-- Email-specific control does, or it would silently never take effect for
-- appointment/phone-call reminder emails despite appearing to work.
ALTER TABLE reminder_leads ADD COLUMN IF NOT EXISTS customer_email_reminders_disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE test_leads ADD COLUMN IF NOT EXISTS customer_email_reminders_disabled BOOLEAN NOT NULL DEFAULT false;

-- Defaulting both new columns to false preserves every existing lead's
-- current, real behavior exactly: a lead that already had reminders
-- "enabled" (master false) keeps getting both channels; a lead that
-- already had the master disabled keeps getting neither (email already
-- stopped, SMS was never sending in production anyway per
-- SMS_AUTOMATED_REMINDERS_ENABLED's own off-by-default gate) — "Do NOT
-- enable SMS by default for users who previously had it disabled" is
-- satisfied by construction: nothing here flips a value to true for any
-- row, ever.
