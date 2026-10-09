-- platform_companies — control-plane registry of every company installation
-- provisioned through the Company Management page (PRODUCTIZATION —
-- multi-company onboarding workflow).
--
-- ARCHITECTURE NOTE: this table is part of the ONE shared codebase (every
-- installation's migrations create it), but it is only ever POPULATED on
-- the installation an authorized platform administrator actually uses to
-- provision OTHER companies from (in practice, EC's own production
-- database) — see lib/rbac.js#requirePlatformAdmin, which gates every
-- route that reads/writes this table on the caller's email being present
-- in THIS installation's OWN company_settings.protected_admin_emails (never
-- a hardcoded company-specific literal). A brand-new company's own
-- installation has protected_admin_emails = [] (bootstrap.js's explicit,
-- deliberate default), so this table exists but is permanently unreachable
-- and empty there — nobody at a customer company ever sees or populates it.
--
-- This table NEVER holds another company's business data (leads, deals,
-- customers, documents) — only provisioning/contact metadata needed to
-- track and manage the onboarding lifecycle. The one sensitive field,
-- database_url_encrypted, is encrypted at rest with the SAME AES-256-CBC
-- scheme already used for integration_credentials
-- (lib/integrationCredentialStore.js#encryptPayload/decryptPayload, keyed
-- by this installation's own ENCRYPTION_KEY) — it is the connection string
-- to that OTHER company's own, separate Postgres database (never a copy of
-- its data), used only for the explicit, admin-triggered provisioning /
-- resend-invite / suspend / activate actions
-- (lib/platformProvisioning.js) — never for routine request traffic.
CREATE TABLE IF NOT EXISTS platform_companies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name             TEXT NOT NULL,
  company_slug             TEXT NOT NULL,
  owner_email              TEXT NOT NULL,
  owner_name               TEXT,
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','awaiting_infrastructure','provisioning','ready_to_invite','invited','activated','suspended','failed')),
  config_json              JSONB NOT NULL DEFAULT '{}'::jsonb,
  database_url_encrypted   TEXT,
  frontend_url             TEXT,
  backend_url              TEXT,
  contract_version         TEXT,
  last_error               TEXT,
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provisioned_at           TIMESTAMPTZ,
  invited_at               TIMESTAMPTZ,
  activated_at             TIMESTAMPTZ,
  suspended_at             TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_companies_slug_uidx ON platform_companies (company_slug);
