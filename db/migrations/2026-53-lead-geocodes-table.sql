-- =====================================================================
-- 2026-53-lead-geocodes-table.sql — Move lead_geocodes table creation
-- out of the request path and into the migration system.
--
-- lib/addressPipeline.js#ensureGeocodeTable (shared by routes/routing.js
-- and routes/routingDiagnostic.js) was running
--   CREATE TABLE IF NOT EXISTS lead_geocodes (...)
--   CREATE INDEX IF NOT EXISTS idx_lead_geocodes_hash ...
-- as raw runtime DDL — previously UNMEMOIZED, so it ran on EVERY request
-- to 3+ routing endpoints, violating CLAUDE.md's "No DDL at runtime"
-- rule (deploy-time DDL only, via db/migrate.js). Even after memoizing
-- it to run at most once per process, the table still belongs here —
-- deploy-time, applied once, like every other table in this schema.
--
-- Startup-safe: CREATE TABLE/INDEX IF NOT EXISTS, idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS lead_geocodes (
  lead_id TEXT PRIMARY KEY,
  address_hash TEXT NOT NULL,
  normalized_address TEXT,
  verified_address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  google_place_id TEXT,
  geocode_status TEXT DEFAULT 'pending',
  geocoded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_geocodes_hash ON lead_geocodes (address_hash);

ALTER TABLE lead_geocodes ADD COLUMN IF NOT EXISTS verified_address TEXT;
