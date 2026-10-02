-- =====================================================================
-- 2026-50-company-identity-slug-currency.sql
--
-- PRODUCTIZATION — Company Provisioning System: two small additive
-- identity fields needed by the installation contract
-- (scripts/install/companyConfigContract.js) that company_settings didn't
-- carry yet:
--
--   - company_slug: a short, stable, human-readable identifier for this
--     installation (e.g. "acme-remodeling"), used by the provisioner to
--     name generated artifacts (env manifests, report filenames) and by
--     ops tooling to refer to an installation without a UUID. NEVER used
--     for request routing or tenant scoping — this remains a single
--     company per database/deployment (docs/PRODUCT_ARCHITECTURE.md).
--     Nullable; EC's own row simply has none until an operator sets one.
--   - currency: an ISO 4217 code (e.g. "USD", "CAD", "GBP"). Captured as
--     configuration now because a future non-US company needs it, but NOT
--     yet wired into any frontend financial display
--     (crm-frontend/src/lib/financialCalc.js#formatCurrency still hardcodes
--     "USD"/"en-US") — same deferred-but-tracked status as `locale`'s
--     incomplete rollout (see docs/CONFIGURATION_REFERENCE.md). Default
--     'USD' is a legitimate universal product default, not an EC-specific
--     fact — unlike every other column in 2026-46/47, there is no EC
--     hardcoded literal to preserve here, so this default applies
--     identically to every row, old or new.
-- =====================================================================

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS company_slug TEXT;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
