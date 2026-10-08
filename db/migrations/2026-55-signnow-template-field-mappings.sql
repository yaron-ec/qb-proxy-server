-- =====================================================================
-- 2026-55: SignNow template field mappings (CRM STABILITY PHASE,
-- completion pass, Section A4).
--
-- No SignNow account has persistent Contacts exposed via its documented
-- public REST API (confirmed from docs.signnow.com's own reference
-- categories: User/OAuth/Document/Template/Folder/Document Group/Webhook/
-- Embedded — no Contacts resource; the Help Center frames "Contacts" as a
-- pure web-app/UI feature, not an API object). The field-invite mechanism
-- (POST /document/{id}/invite, already used by lib/signnowClient.js's
-- sendInvite) already takes recipient email/name/role directly with no
-- Contact-object dependency, so there is nothing to "sync" there.
--
-- The genuinely missing piece was CRM -> template data population: a real
-- HIC template's text fields (name, address, phone, project amount, etc.)
-- had to be re-typed by hand every time. This table is the reusable,
-- admin-configurable mapping layer (never hardcoded field IDs scattered
-- through frontend components — CLAUDE.md's own requirement for this
-- exact gap) from a SignNow template's text-field names to CRM data, used
-- by lib/signnowFieldMapping.js + routes/signnow.js's /prepare route.
--
-- One real HIC template's actual field names are account-specific and
-- unknowable without live, credentialed SignNow access (none is available
-- in this environment) — this table starts EMPTY. An admin populates it
-- once per template via the SignNow settings UI (GET
-- /api/v1/signnow/field-mappings/:templateId to see the document's live
-- fields after a first "Prepare", PUT to save the mapping). Until a
-- template has mappings configured, /prepare behaves exactly as before
-- this migration (no prefill attempted, no behavior change) — this is
-- purely additive.
--
-- Startup-safe: additive table only, CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS signnow_template_field_mappings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         TEXT NOT NULL,
  signnow_field_name  TEXT NOT NULL,   -- the field's "name" as SignNow returns it on the copied document
  field_label         TEXT,            -- human label for the admin UI, e.g. "Customer Street Address"
  crm_source          TEXT NOT NULL,   -- key into lib/signnowFieldMapping.js's CRM_SOURCES allowlist
  required            BOOLEAN NOT NULL DEFAULT false,  -- if true, missing CRM data blocks /prepare
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, signnow_field_name)
);

CREATE INDEX IF NOT EXISTS signnow_template_field_mappings_template_idx
  ON signnow_template_field_mappings (template_id);
