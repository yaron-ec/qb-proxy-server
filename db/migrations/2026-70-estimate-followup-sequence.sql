-- =====================================================================
-- 2026-70-estimate-followup-sequence.sql — Automated 14-day estimate
-- follow-up email sequence (six emails: Day 1/3/5/8/11/14).
--
-- Architecture summary (see lib/estimateFollowupEngine.js for the full
-- design rationale):
--   - estimate_followup_sequences: one row per lead enrolled against one
--     specific handoff_estimates row. A lead can have at most one
--     active-or-paused sequence at a time (partial unique index below) —
--     this is what prevents a revised/second estimate from starting a
--     COMPETING sequence; a new one can only start once the prior one has
--     reached a terminal state (completed/stopped).
--   - estimate_followup_steps: the 6 pre-computed, individually-tracked
--     steps for a sequence. Each step's send goes through the EXISTING
--     lib/emailService.js (its own idempotency_key, retry and audit
--     columns already cover "no duplicate sends after retries/restarts/
--     redeploys" — this schema does not re-implement that, it only tracks
--     per-step SCHEDULING state: pending -> processing -> sent/skipped/
--     failed/cancelled).
--   - estimate_followup_templates: the six editable, VERSIONED email
--     bodies. Editing never mutates history — it inserts a new version row
--     and flips which one is_active, mirroring this codebase's established
--     "additive migration, never edit an applied one" philosophy applied
--     to admin-editable content instead of schema.
--   - estimate_followup_suppressions: a permanent, email-keyed opt-out
--     list — mirrors sms_opt_outs' own "keyed by the contact method
--     forever, independent of which lead row it's ever matched to" pattern,
--     specifically so an unsubscribe survives a later QuickBooks/Handoff
--     re-sync that touches the same lead.
--
-- Nothing here touches leads, handoff_estimates, or any QuickBooks/
-- financial table — this is a purely additive, independent feature schema.
-- =====================================================================

CREATE TABLE IF NOT EXISTS estimate_followup_sequences (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  handoff_estimate_id             UUID REFERENCES handoff_estimates(id) ON DELETE SET NULL,
  status                          TEXT NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'paused', 'completed', 'stopped')),
  recipient_email                 TEXT NOT NULL,
  sales_rep_owner_id              UUID REFERENCES owners(id),
  -- The verified delivery-to-customer instant this entire schedule is
  -- anchored to. Set by an authorized user's explicit "Confirm Estimate
  -- Sent" action (lib/estimateFollowupEngine.js#confirmEstimateSent) —
  -- NEVER inferred from estimate creation/import/sync, and never backdated
  -- automatically; defaults to the moment of confirmation, and may only be
  -- set to an earlier real date by the confirming user's own explicit input.
  estimate_sent_confirmed_at      TIMESTAMPTZ NOT NULL,
  estimate_sent_confirmed_by      TEXT NOT NULL,
  estimate_sent_confirmation_note TEXT,
  enrollment_method               TEXT NOT NULL DEFAULT 'confirm_sent'
                                    CHECK (enrollment_method IN ('confirm_sent', 'manual_enroll')),
  -- SHA-256 of a 32-random-byte opaque unsubscribe token — same security
  -- pattern as lib/actionTokenStore.js (raw token lives only in the email
  -- link, never stored/logged). One token per SEQUENCE (not per step/send):
  -- clicking unsubscribe from ANY of the six emails stops all of them.
  unsubscribe_token_hash          TEXT NOT NULL UNIQUE,
  paused_reason                   TEXT,
  paused_at                       TIMESTAMPTZ,
  paused_by                       TEXT,
  stopped_reason                  TEXT,
  stopped_at                      TIMESTAMPTZ,
  stopped_by                      TEXT,
  completed_at                    TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one non-terminal (active/paused) sequence per lead at a time —
-- the mechanism that prevents a revised or second estimate from starting a
-- competing sequence. A new enrollment is only possible once the existing
-- one reaches completed/stopped.
CREATE UNIQUE INDEX IF NOT EXISTS estimate_followup_sequences_one_live_per_lead
  ON estimate_followup_sequences (lead_id) WHERE status IN ('active', 'paused');

CREATE INDEX IF NOT EXISTS estimate_followup_sequences_lead_idx
  ON estimate_followup_sequences (lead_id);
CREATE INDEX IF NOT EXISTS estimate_followup_sequences_status_idx
  ON estimate_followup_sequences (status);

CREATE OR REPLACE FUNCTION estimate_followup_sequences_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS estimate_followup_sequences_set_updated_at ON estimate_followup_sequences;
CREATE TRIGGER estimate_followup_sequences_set_updated_at BEFORE UPDATE ON estimate_followup_sequences
  FOR EACH ROW EXECUTE FUNCTION estimate_followup_sequences_touch_updated_at();

CREATE TABLE IF NOT EXISTS estimate_followup_steps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id      UUID NOT NULL REFERENCES estimate_followup_sequences(id) ON DELETE CASCADE,
  step_number      INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 6),
  day_offset       INTEGER NOT NULL,
  template_key     TEXT NOT NULL,
  due_at           TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  skipped_reason   TEXT,
  sent_at          TIMESTAMPTZ,
  -- Gmail API accepted this message — see lib/estimateFollowupEngine.js's
  -- own header on why this is NEVER surfaced to the frontend as "Delivered":
  -- Gmail provides no delivery/read confirmation in this codebase, the same
  -- documented limitation as the existing reminder emails.
  gmail_message_id TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sequence_id, step_number)
);

CREATE INDEX IF NOT EXISTS estimate_followup_steps_due_idx
  ON estimate_followup_steps (due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS estimate_followup_steps_sequence_idx
  ON estimate_followup_steps (sequence_id);

CREATE OR REPLACE FUNCTION estimate_followup_steps_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS estimate_followup_steps_set_updated_at ON estimate_followup_steps;
CREATE TRIGGER estimate_followup_steps_set_updated_at BEFORE UPDATE ON estimate_followup_steps
  FOR EACH ROW EXECUTE FUNCTION estimate_followup_steps_touch_updated_at();

-- Editable, versioned templates. Editing (lib/estimateFollowupTemplates.js
-- #saveTemplateVersion) INSERTs a new row and flips is_active — it never
-- UPDATEs body_html/subject on an existing version, so history is complete
-- and auditable (which version of which wording was actually sent to a
-- given customer is always reconstructable from estimate_followup_steps'
-- own template_key + sent_at against this table's version history).
CREATE TABLE IF NOT EXISTS estimate_followup_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT NOT NULL,
  version      INTEGER NOT NULL,
  subject      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT,
  UNIQUE (template_key, version)
);

-- Exactly one active version per template_key.
CREATE UNIQUE INDEX IF NOT EXISTS estimate_followup_templates_one_active
  ON estimate_followup_templates (template_key) WHERE is_active;

-- Permanent, email-keyed suppression — independent of any specific lead,
-- so it survives a lead being re-created/re-synced by a later QuickBooks/
-- Handoff import under the same email address. Checked before every
-- enrollment AND fresh before every single send.
CREATE TABLE IF NOT EXISTS estimate_followup_suppressions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'customer_unsubscribe',
  sequence_id UUID REFERENCES estimate_followup_sequences(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Seed the six default templates (version 1, active) ──────────────────
-- Exact wording as given by the business owner — not Claude-authored —
-- mirroring lib/smsTemplates.js's own "one-time approval record" precedent
-- for customer-facing copy. A compliance footer (physical business address,
-- unsubscribe link) is appended at RENDER time by
-- lib/estimateFollowupTemplates.js, never baked into body_html, so an
-- address change in Company Settings never requires a new template
-- version. ON CONFLICT DO NOTHING: safe to re-run; never overwrites an
-- admin's own edited active version on a later deploy.
INSERT INTO estimate_followup_templates (template_key, version, subject, body_html, is_active, created_by)
VALUES
  ('day1', 1, 'Just checking in about your estimate',
   '<p>Hi {{first_name}},</p>' ||
   '<p>I wanted to follow up and make sure you received the estimate for your project.</p>' ||
   '<p>If you have any questions or would like to go over anything together, I''m happy to help.</p>' ||
   '<p>Looking forward to hearing your thoughts!</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70'),
  ('day3', 1, 'Any questions about your project?',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Just wanted to check if you''ve had a chance to look over the estimate.</p>' ||
   '<p>Sometimes questions come up after you''ve had a little time to review everything. Whether it''s about the scope of work, materials, or budget, feel free to reach out.</p>' ||
   '<p>I''m happy to walk through the details with you.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70'),
  ('day5', 1, 'A quick note about your project',
   '<p>Hi {{first_name}},</p>' ||
   '<p>I know choosing the right contractor is an important decision.</p>' ||
   '<p>At EC Construction Group, we want you to feel comfortable with the process and understand what to expect before moving forward.</p>' ||
   '<p>If there''s anything you''d like us to explain further about your estimate or how the project would work, just let me know.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70'),
  ('day8', 1, 'Checking in on your plans',
   '<p>Hi {{first_name}},</p>' ||
   '<p>I wanted to see where things stand with your project.</p>' ||
   '<p>Are you still considering moving forward, or is there anything you''d like to discuss before making a decision?</p>' ||
   '<p>No pressure at all. I just want to make sure you have the information you need.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70'),
  ('day11', 1, 'Happy to go over the details',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Just reaching out to see if it would be helpful to go over the estimate together one more time.</p>' ||
   '<p>We can review the scope, answer any remaining questions, and talk through the next steps whenever you''re ready.</p>' ||
   '<p>Feel free to reply here, and we can find a good time to connect.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70'),
  ('day14', 1, 'Should I keep your project on my radar?',
   '<p>Hi {{first_name}},</p>' ||
   '<p>I wanted to follow up one last time regarding the estimate we sent over.</p>' ||
   '<p>I understand plans and timelines can change, so if now isn''t the right time, that''s completely fine.</p>' ||
   '<p>If you''d still like to move forward or have any questions, just reply to this email. We''d be happy to help.</p>' ||
   '<p>Wishing you all the best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-70')
ON CONFLICT (template_key, version) DO NOTHING;
