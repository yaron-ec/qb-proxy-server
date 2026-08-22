-- =====================================================================
-- 2026-16: SignNow documents + Lead submissions tables
-- Native Railway storage for Lead Detail page (no Base44).
-- Idempotent — safe to re-run.
-- =====================================================================

-- ── signnow_documents ──────────────────────────────────────────────────
-- Stores SignNow document metadata for leads. The actual PDF content
-- lives in SignNow's servers; this table tracks the document ID, status,
-- and signing URL so the CRM can display contract status per lead.
CREATE TABLE IF NOT EXISTS signnow_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  document_id     TEXT UNIQUE,                    -- SignNow document ID
  document_name   TEXT,                            -- Display name
  template_id     TEXT,                            -- Source template ID (if from template)
  status          TEXT NOT NULL DEFAULT 'pending'  -- pending|sent|viewed|signed|completed|voided|error
                  CHECK (status IN ('pending','sent','viewed','signed','completed','voided','error')),
  signers         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ email, name, role, status }]
  signing_url     TEXT,                            -- URL for the signer to sign
  pdf_url         TEXT,                            -- URL to the signed PDF (when completed)
  created_by      TEXT,                            -- User email who created it
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS signnow_documents_lead_idx ON signnow_documents (lead_id, created_at DESC);

CREATE OR REPLACE FUNCTION signnow_documents_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS signnow_documents_set_updated_at ON signnow_documents;
CREATE TRIGGER signnow_documents_set_updated_at BEFORE UPDATE ON signnow_documents
  FOR EACH ROW EXECUTE FUNCTION signnow_documents_touch_updated_at();

-- ── lead_submissions ──────────────────────────────────────────────────
-- Tracks each time a lead submits a form (capture form, chat, phone call).
-- Replaces the Base44 LeadSubmission entity. Fed by the lead ingest flow
-- and the public capture endpoint.
CREATE TABLE IF NOT EXISTS lead_submissions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                 TEXT,                     -- Website, Google Search, etc.
  form_type              TEXT,                     -- Short Quote Form, Consultation Form, etc.
  project_type           TEXT,
  message                TEXT,
  assigned_rep_at_time   TEXT,                     -- Rep name at time of submission
  lead_status_at_time    TEXT,                     -- Lead status at time of submission
  submission_number      INTEGER NOT NULL DEFAULT 1,  -- 1 = first, 2 = second, etc.
  was_reactivation       BOOLEAN NOT NULL DEFAULT FALSE,
  previous_status        TEXT,                     -- If reactivation, the previous status
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lead_submissions_lead_idx ON lead_submissions (lead_id, submitted_at DESC);