-- =====================================================================
-- 2026-74-estimate-followup-estimate-level-dedup.sql — closes a real
-- structural gap found during the November 2026 estimate-sent-verification
-- investigation: estimate_followup_sequences_one_live_per_lead (migration
-- 2026-70) only prevents a SECOND sequence for the SAME lead — it does
-- nothing to stop TWO DIFFERENT leads from each enrolling a sequence for
-- the SAME real QuickBooks estimate.
--
-- This is not theoretical. A live, read-only audit of production
-- handoff_estimates found exactly this shape for QuickBooks estimate
-- HNDF-EST-10260 (qb_estimate_id=78): one row created in the original
-- 2026-08-26 bulk import, matched to lead A; a second row created
-- independently by a later live sync pass (2026-10-01), matched to a
-- DIFFERENT lead B. Both rows are real, both reference the same estimate.
-- If that estimate were ever Pending with QuickBooks EmailSent evidence,
-- the existing lead-scoped index would let BOTH lead A and lead B be
-- independently enrolled for the same real estimate — two six-email
-- sequences, to two different recipients, for one project.
--
-- Fix: denormalize the estimate's own qb_estimate_id onto
-- estimate_followup_sequences (populated at enroll() time from the linked
-- handoff_estimates row) and add a SECOND partial unique index on it,
-- scoped the same way as the lead-level one (active/paused only — a
-- completed/stopped sequence must never block a legitimate future
-- enrollment for a revised/different estimate). This is a DATABASE-LEVEL,
-- concurrency-safe guard — two simultaneous enrollment attempts (manual +
-- auto, or two reps racing) for the same qb_estimate_id can both pass an
-- application-level pre-check and still only one will win the INSERT;
-- lib/estimateFollowupEngine.js#enroll() maps the resulting unique-
-- violation to a new, specific `competing_sequence_for_same_estimate`
-- reason (distinct from the existing lead-level
-- `competing_sequence_already_active`), and
-- lib/estimateFollowupEligibility.js also pre-checks it (same two-layer
-- shape — app-level pre-check + DB constraint as the real backstop — the
-- lead-level protection already uses).
--
-- No historical estimate_followup_sequences rows exist in production as of
-- this migration (the feature has never left dry-run / had a real
-- enrollment) — the backfill below is a no-op there, but is still correct
-- for any seeded test/dev data.
--
-- Does NOT touch handoff_estimates itself in any way — no deletion,
-- merging, or rewriting of the duplicate estimate rows the investigation
-- found, per explicit instruction. Those rows (and the cross-lead
-- duplication they represent) are left exactly as they are; this migration
-- only prevents the FOLLOW-UP SEQUENCE layer from ever acting on both of
-- them at once.
-- =====================================================================

ALTER TABLE estimate_followup_sequences
  ADD COLUMN IF NOT EXISTS qb_estimate_id TEXT;

UPDATE estimate_followup_sequences seq
   SET qb_estimate_id = he.qb_estimate_id
  FROM handoff_estimates he
 WHERE he.id = seq.handoff_estimate_id
   AND seq.qb_estimate_id IS NULL
   AND he.qb_estimate_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS estimate_followup_sequences_one_live_per_estimate
  ON estimate_followup_sequences (qb_estimate_id) WHERE status IN ('active', 'paused') AND qb_estimate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS estimate_followup_sequences_qb_estimate_id_idx
  ON estimate_followup_sequences (qb_estimate_id);
