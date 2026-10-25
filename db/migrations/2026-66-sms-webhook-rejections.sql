-- 2026-66-sms-webhook-rejections.sql
--
-- October 2026 inbound-SMS incident: a signature-rejected Twilio webhook
-- attempt (inbound message OR delivery-status callback) previously left NO
-- trace anywhere except a bare `console.warn` line in Railway logs — no row,
-- no queryable evidence. Exactly mirrors the gap
-- 2026-58-website-lead-intake-rejections.sql closed for website lead intake:
-- "0 inbound messages received" in System Health was indistinguishable from
-- "Twilio has never once attempted delivery" versus "Twilio has been trying
-- and getting rejected every time" (e.g. the signature-verification base URL
-- — see lib/smsClient.js#webhookBaseUrl's header — pointing at the wrong
-- domain). This table records every rejection (never the computed/expected
-- signature value, never the auth token) so that distinction becomes
-- directly visible to an operator without Railway log access.
--
-- Startup-safe: additive table only, no existing table touched.

CREATE TABLE IF NOT EXISTS sms_webhook_rejections (
  id                  BIGSERIAL PRIMARY KEY,
  path                TEXT NOT NULL,              -- 'inbound' | 'status'
  computed_url        TEXT,                        -- the URL our server expected Twilio to have signed against (directly comparable to Twilio Console's configured webhook URL)
  host_header         TEXT,                        -- the Host header the request actually arrived with
  has_signature_header BOOLEAN NOT NULL DEFAULT false,
  message_sid         TEXT,                        -- best-effort — Twilio's form body is still parseable even when the signature doesn't verify
  from_number         TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_webhook_rejections_received_at_idx
  ON sms_webhook_rejections (received_at);
