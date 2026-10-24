-- CRM New Lead intake SMS consent (Philippines appointment-setting
-- representatives). Reuses the EXISTING leads.sms_consent / sms_consent_at /
-- sms_consent_source / sms_consent_disclosure_version columns (added by
-- 2026-43-website-lead-intake.sql) as the SAME one consent gate Twilio
-- sending already checks (lib/smsService.js#sendSms) — no new consent
-- column, no second gate. The one new column below adds WHO recorded it
-- (the existing columns already cover when/source/script-version).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_recorded_by TEXT;
