-- Twilio SMS integration (two-way messaging). Reuses the existing
-- leads.sms_consent* columns (added by 2026-43-website-lead-intake.sql) as
-- the ONE consent gate for every outbound CRM-triggered SMS in this phase —
-- Lead Detail compose and appointment/follow-up SMS are all transactional/
-- service messaging, not marketing, so no separate marketing-consent column
-- is introduced yet. A genuine future marketing-SMS capability needs its own
-- consent column + disclosure copy — a deliberate product decision, not a
-- silent side effect of this migration.

-- Two-way SMS message log, one row per message (both directions), linked to
-- a lead only when a confident phone match exists. An inbound message that
-- cannot be confidently matched to exactly one lead is still stored
-- (lead_id NULL, ambiguous_match flag + candidate_lead_ids) — never silently
-- dropped, and never guessed onto the wrong customer.
CREATE TABLE IF NOT EXISTS sms_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID REFERENCES leads(id) ON DELETE SET NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  from_number           TEXT NOT NULL,
  to_number             TEXT NOT NULL,
  body                  TEXT NOT NULL,
  twilio_sid            TEXT UNIQUE,            -- Twilio MessageSid; the idempotency key for both directions
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sent','delivered','failed','undelivered','received')),
  error_code            TEXT,
  error_message         TEXT,
  ambiguous_match       BOOLEAN NOT NULL DEFAULT false,
  candidate_lead_ids    UUID[],                 -- populated only when ambiguous_match = true
  sent_by               TEXT,                   -- rep email; outbound only, NULL for inbound/automated
  keyword               TEXT,                   -- detected STOP/START/HELP keyword, if any (inbound only)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_lead_id ON sms_messages(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_to_number ON sms_messages(to_number);
CREATE INDEX IF NOT EXISTS idx_sms_messages_from_number ON sms_messages(from_number);

-- Phone-level opt-out registry — deliberately independent of any lead match:
-- a STOP can arrive from a number that doesn't match any lead at all, and the
-- opt-out must still be honored for any FUTURE lead that number is ever
-- attached to. phone_number is stored in the SAME bare-last-10-digit form
-- lib/captureValidation.js#normalizePhone produces, so a lookup never needs a
-- second normalization scheme (the same tolerant-matching choice this phase
-- uses for inbound-message-to-lead matching).
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number      TEXT NOT NULL UNIQUE,
  opted_out         BOOLEAN NOT NULL DEFAULT true,
  opted_out_at      TIMESTAMPTZ,
  opted_in_at       TIMESTAMPTZ,
  last_keyword      TEXT,
  source            TEXT NOT NULL DEFAULT 'customer_reply' CHECK (source IN ('customer_reply','manual')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
