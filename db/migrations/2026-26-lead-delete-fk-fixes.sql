-- =====================================================================
-- 2026-26-lead-delete-fk-fixes.sql — Fix Lead deletion FK constraints
--
-- Problem: Deleting a Lead fails because multiple tables reference leads(id)
-- with ON DELETE NO ACTION (the PostgreSQL default when no ON DELETE clause
-- is specified). The browser error was:
--   "update or delete on table "leads" violates foreign key constraint
--    appointments_lead_id_fkey on table "appointments""
--
-- This migration fixes the FK behavior for every Lead-dependent table:
--
--   Lead-owned (CASCADE — no independent business value without the Lead):
--     booking_idempotency   → leads(id) ON DELETE CASCADE
--     projection_outbox     → leads(id) ON DELETE CASCADE
--     base44_entity_map     → leads(id) ON DELETE CASCADE
--     calendar_outbox       → appointments(id) ON DELETE CASCADE
--     appointment_events    → appointments(id) ON DELETE CASCADE
--
--   Appointments (SET NULL — appointments are IMMUTABLE, no physical DELETE):
--     appointments.lead_id  → DROP NOT NULL + ON DELETE SET NULL
--     The application cancels active appointments (status='cancelled') and
--     enqueues calendar outbox cancellations BEFORE deleting the lead.
--     The FK SET NULL preserves the immutable audit trail.
--
--   Business records (SET NULL — record survives, Lead reference unlinked):
--     deals.lead_id         → DROP NOT NULL + ON DELETE SET NULL
--     (deal_expenses, deal_commissions, deal_loan_payments, properties,
--      handoff_estimates, estimates already have ON DELETE SET NULL)
--
--   Already correct (CASCADE — Lead-owned):
--     activities, tasks, invoices, lead_attachments, lead_submissions,
--     signnow_documents
--
-- Idempotent: uses DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
-- =====================================================================

-- ── appointments → leads: SET NULL (appointments are immutable, no physical DELETE) ─
-- The appointments table has a RULE that blocks physical DELETE (audit trail).
-- CASCADE cannot work — it tries to physically DELETE appointment rows.
-- The application cancels active appointments + enqueues calendar outbox
-- cancellations BEFORE deleting the lead. The FK SET NULL preserves the
-- immutable appointment record with lead_id = NULL.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_lead_id_fkey;
ALTER TABLE appointments ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE appointments ADD CONSTRAINT appointments_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

-- ── booking_idempotency → leads: CASCADE (Lead-owned idempotency tokens) ──
ALTER TABLE booking_idempotency DROP CONSTRAINT IF EXISTS booking_idempotency_lead_id_fkey;
ALTER TABLE booking_idempotency ADD CONSTRAINT booking_idempotency_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- ── projection_outbox → leads: CASCADE (Lead-owned projection events) ────
ALTER TABLE projection_outbox DROP CONSTRAINT IF EXISTS projection_outbox_lead_id_fkey;
ALTER TABLE projection_outbox ADD CONSTRAINT projection_outbox_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- ── base44_entity_map → leads: CASCADE (Lead-owned mapping record) ───────
ALTER TABLE base44_entity_map DROP CONSTRAINT IF EXISTS base44_entity_map_railway_lead_id_fkey;
ALTER TABLE base44_entity_map ADD CONSTRAINT base44_entity_map_railway_lead_id_fkey
  FOREIGN KEY (railway_lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- ── calendar_outbox → appointments: CASCADE (appointment-owned sync events) ─
ALTER TABLE calendar_outbox DROP CONSTRAINT IF EXISTS calendar_outbox_appointment_id_fkey;
ALTER TABLE calendar_outbox ADD CONSTRAINT calendar_outbox_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE;

-- ── appointment_events → appointments: CASCADE (appointment-owned event log) ─
ALTER TABLE appointment_events DROP CONSTRAINT IF EXISTS appointment_events_appointment_id_fkey;
ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE;

-- ── deals → leads: SET NULL (business record survives, Lead unlinked) ────
-- deals.lead_id is currently NOT NULL; we must make it nullable so SET NULL
-- can work. A Deal represents a sale — it must survive Lead deletion.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_lead_id_fkey;
ALTER TABLE deals ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE deals ADD CONSTRAINT deals_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;