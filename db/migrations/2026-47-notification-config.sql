-- =====================================================================
-- 2026-47-notification-config.sql
--
-- PRODUCTIZATION PHASE 2: makes operational-notification routing and the
-- "default owner" assumption (who a lead/deal/call routes to when no
-- explicit owner exists) into per-installation configuration, instead of
-- lib/crmActivityNotifier.js and ~10 other files hardcoding
-- michelle@ecconstructiongroup.com / yaron@ecconstructiongroup.com /
-- 'Yaron Drilevich' as literals.
--
-- Purely ADDITIVE, same discipline as 2026-44:
--   - every new column's DEFAULT equals EC's actual current hardcoded
--     behavior, so an EC-shaped row upgrades with byte-identical effective
--     behavior;
--   - scripts/install/bootstrap.js explicitly writes a DIFFERENT, neutral
--     value for a brand-new installation's INSERT (see ensureCompanySettings),
--     the same pattern already used for enabled_modules in 2026-44 — the
--     column default and the fresh-install value are deliberately different,
--     and that is not a contradiction: the default protects EC's upgrade,
--     bootstrap protects Company #2's fresh install.
-- =====================================================================

-- ── Operational/staff notification recipients ───────────────────────────────
-- Shape: {"to": ["a@x.com"], "cc": ["b@x.com", ...]}. Read via
-- lib/notificationRecipients.js, never directly. EC's actual current
-- behavior (lib/crmActivityNotifier.js and ~9 other files, before this
-- migration) was an unconditional Michelle-to/Yaron-cc on nearly every
-- staff-facing email — preserved here as the default for any row that
-- predates this column.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS notification_recipients JSONB NOT NULL DEFAULT
  '{"to": ["michelle@ecconstructiongroup.com"], "cc": ["yaron@ecconstructiongroup.com"]}'::jsonb;

-- ── Outbound email sender display name ──────────────────────────────────────
-- Matches the literal 'EC Construction Group' / 'EC Construction CRM' names
-- hardcoded in lib/crmActivityNotifier.js, lib/reminderEngine.js,
-- lib/phoneCallReminders.js, lib/reminderNotifications.js.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS email_from_name TEXT NOT NULL DEFAULT 'EC Construction CRM';

-- ── Default owner (routing fallback when a lead/call has no assigned rep) ───
-- Matches lib/metaLeadMapper.js, routes/metaWebhook.js's hardcoded
-- owner_email: 'yaron@ecconstructiongroup.com' / assigned_rep: 'Yaron Drilevich',
-- and routes/leads.js's Google Contacts impersonation fallback.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS default_owner_email TEXT NOT NULL DEFAULT 'yaron@ecconstructiongroup.com';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS default_owner_name TEXT NOT NULL DEFAULT 'Yaron Drilevich';

-- ── Protected admin accounts (cannot be deleted via the Users API) ─────────
-- Matches routes/users.js's hardcoded single-email protection
-- ('Cannot delete the owner of the app'). EC's absolute requirement is that
-- BOTH Yaron and Michelle remain admins — a single hardcoded email under-
-- protected that requirement even before productization. Empty array for a
-- fresh install: a new installation's own bootstrap-created admin has no
-- special protection beyond the generic "cannot delete the last remaining
-- admin" rule (routes/users.js), which applies to every installation.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS protected_admin_emails JSONB NOT NULL DEFAULT
  '["yaron@ecconstructiongroup.com", "michelle@ecconstructiongroup.com"]'::jsonb;
