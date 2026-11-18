-- =====================================================================
-- 2026-76-sold-welcome-email.sql — schema for the automated "Sold"
-- customer welcome email (lib/soldWelcomeEmail.js).
--
-- One row per LEAD (UNIQUE(lead_id)) — this is the durable, authoritative
-- record of whether the welcome email has ever been sent/skipped/failed
-- for that lead. This is the real idempotency backstop (never resend once
-- a row reaches 'sent'), ON TOP OF lib/emailService.js's own
-- email_send_claims idempotency-key uniqueness — belt and suspenders, same
-- two-layer shape this codebase already uses elsewhere (e.g. the estimate
-- follow-up sequences' lead-level + estimate-level unique indexes).
--
-- status values:
--   'sent'                  — the welcome email was handed to Gmail's send
--                             API successfully (gmail_message_id populated).
--                             NEVER claims delivery, only that sending
--                             succeeded — see lib/soldWelcomeEmail.js header.
--   'skipped_no_email'      — the lead had no email address on file at the
--                             moment the Sold edge fired.
--   'skipped_invalid_email' — the lead had an email address, but it failed
--                             basic format validation.
--   'failed'                — a real send attempt was made and failed after
--                             lib/emailService.js's own bounded retries.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sold_welcome_emails (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  recipient_email    TEXT,
  status             TEXT NOT NULL CHECK (status IN ('sent', 'skipped_no_email', 'skipped_invalid_email', 'failed')),
  subject            TEXT,
  body_html          TEXT,
  idempotency_key    TEXT,
  gmail_message_id   TEXT,
  sent_at            TIMESTAMPTZ,
  error_message      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  triggered_by       TEXT,
  owner_notified_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sold_welcome_emails_status ON sold_welcome_emails(status);

CREATE OR REPLACE FUNCTION sold_welcome_emails_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sold_welcome_emails_set_updated_at ON sold_welcome_emails;
CREATE TRIGGER sold_welcome_emails_set_updated_at BEFORE UPDATE ON sold_welcome_emails
  FOR EACH ROW EXECUTE FUNCTION sold_welcome_emails_touch_updated_at();
