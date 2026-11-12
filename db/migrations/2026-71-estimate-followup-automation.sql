-- =====================================================================
-- 2026-71-estimate-followup-automation.sql — fully automatic estimate-
-- sent detection + Gmail inbound-reply detection for the estimate
-- follow-up sequence (see db/migrations/2026-70-estimate-followup-
-- sequence.sql for the base schema this extends).
--
-- Three independent additions:
--
--   1. handoff_estimates ADD qb_email_status / qb_email_delivery_time —
--      the RAW QuickBooks Estimate.EmailStatus / DeliveryInfo.DeliveryTime
--      fields, persisted verbatim on every QB estimate sync tick
--      (server.js#runQbEstimateSyncInner already fetches `SELECT *`, so
--      these fields are already present in every API response today —
--      this requires ZERO new QuickBooks API calls or OAuth scope).
--      lib/estimateSentDetection.js's classifier reads these two columns
--      to decide whether an estimate's delivery to the customer can be
--      automatically confirmed (EmailStatus = 'EmailSent'). Additive,
--      nullable — never touches estimate_status, which keeps its
--      existing Pending/Accepted/Closed/Rejected business-approval
--      semantics completely unchanged.
--
--   2. estimate_followup_steps ADD gmail_thread_id — the Gmail thread id
--      Gmail itself assigned to THIS step's sent message (returned
--      directly in the Gmail API send response, no extra API call).
--      lib/estimateFollowupReplyDetection.js's inbound poll compares each
--      new inbound message's own threadId against this column across
--      every active/paused sequence's sent steps — a precise, Gmail-
--      native thread-based correlation, never a guess from the email
--      address alone (per the explicit requirement to prefer thread/
--      message-id-based correlation).
--
--   3. estimate_followup_sequences ADD triggering_gmail_message_id — set
--      only when a sequence is paused/stopped because an inbound reply
--      was detected, holding the exact Gmail message id that triggered
--      it, for audit traceability (the reply itself is recorded as an
--      ordinary 'email' activity row, mirroring the existing Gmail-
--      correspondence convention in routes/leadEmails.js).
--
--   4. estimate_followup_gmail_checkpoint — a durable, single-row
--      (keyed by mailbox) checkpoint for the incremental Gmail
--      history.list poll: the last successfully-processed historyId,
--      poll health (healthy/degraded/unhealthy), and timestamps. This is
--      the state lib/estimateFollowupReplyDetection.js#isReplyMonitoringHealthy
--      reads to decide whether outgoing follow-up sends must be held
--      (fail-closed) because reply monitoring is stale/broken.
--
--   5. estimate_followup_ambiguous_replies — an inbound message that
--      could not be deterministically correlated to exactly one
--      active/paused sequence (e.g. its From address matches more than
--      one currently-enrolled lead, with no thread-id match) is recorded
--      here for manual staff triage — never silently attached to a
--      possibly-wrong lead, mirroring this codebase's existing SMS
--      ambiguous-match convention (lead_id NULL, candidate ids recorded).
--
--   6. estimate_followup_sequences.enrollment_method's CHECK constraint is
--      widened to add 'auto_qb_email_status' — the new, fully-automatic
--      enrollment path (lib/estimateFollowupEngine.js#runAutoEnrollmentScan),
--      triggered by QuickBooks' own EmailStatus='EmailSent' evidence,
--      alongside the two existing human-triggered values ('confirm_sent',
--      'manual_enroll', both kept as manual-override escape hatches per
--      the explicit requirement that manual controls may remain for
--      exceptional cases). This migration has not been merged/deployed
--      anywhere yet, so it is safe to extend in place rather than add a
--      new 2026-72 file — once merged, any further change must be a new
--      migration per this codebase's own "never edit an applied migration"
--      rule.
-- =====================================================================

ALTER TABLE handoff_estimates
  ADD COLUMN IF NOT EXISTS qb_email_status TEXT,
  ADD COLUMN IF NOT EXISTS qb_email_delivery_time TIMESTAMPTZ;

ALTER TABLE estimate_followup_steps
  ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;

ALTER TABLE estimate_followup_sequences
  ADD COLUMN IF NOT EXISTS triggering_gmail_message_id TEXT;

CREATE TABLE IF NOT EXISTS estimate_followup_gmail_checkpoint (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox             TEXT NOT NULL UNIQUE,
  history_id          TEXT,
  status              TEXT NOT NULL DEFAULT 'unhealthy'
                        CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at     TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION estimate_followup_gmail_checkpoint_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS estimate_followup_gmail_checkpoint_set_updated_at ON estimate_followup_gmail_checkpoint;
CREATE TRIGGER estimate_followup_gmail_checkpoint_set_updated_at BEFORE UPDATE ON estimate_followup_gmail_checkpoint
  FOR EACH ROW EXECUTE FUNCTION estimate_followup_gmail_checkpoint_touch_updated_at();

CREATE TABLE IF NOT EXISTS estimate_followup_ambiguous_replies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id     TEXT NOT NULL UNIQUE,
  gmail_thread_id      TEXT,
  from_address         TEXT,
  candidate_sequence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason               TEXT NOT NULL,
  received_at          TIMESTAMPTZ,
  resolved             BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS estimate_followup_ambiguous_replies_resolved_idx
  ON estimate_followup_ambiguous_replies (resolved) WHERE NOT resolved;

ALTER TABLE estimate_followup_sequences
  DROP CONSTRAINT IF EXISTS estimate_followup_sequences_enrollment_method_check;
ALTER TABLE estimate_followup_sequences
  ADD CONSTRAINT estimate_followup_sequences_enrollment_method_check
  CHECK (enrollment_method IN ('confirm_sent', 'manual_enroll', 'auto_qb_email_status'));
