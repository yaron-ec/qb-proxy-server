-- =====================================================================
-- 2026-24: SignNow document additional fields
-- Adds external_ref + Base44 semantic match columns that were missing
-- from the original 2026-16 table definition.
--
-- Columns added:
--   external_ref       — Base44 record ID for idempotent upserts
--   signnow_invite_id  — SignNow invite/correlation ID
--   sent_at            — when the document was sent for signing
--   signed_at          — when the document was signed
--   last_status_check  — when we last checked the signing status
--   uploaded_file_url  — source file URL
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- external_ref — Base44 record ID for idempotent upserts
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- Unique partial index: only enforce uniqueness for non-null external_refs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'signnow_documents_external_ref_idx'
  ) THEN
    CREATE UNIQUE INDEX signnow_documents_external_ref_idx
      ON signnow_documents (external_ref) WHERE external_ref IS NOT NULL;
  END IF;
END $$;

-- signnow_invite_id — SignNow invite/correlation ID
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS signnow_invite_id TEXT;

-- sent_at — when the document was sent for signing
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- signed_at — when the document was signed
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

-- last_status_check — when we last checked the signing status
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS last_status_check TIMESTAMPTZ;

-- uploaded_file_url — source file URL
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS uploaded_file_url TEXT;