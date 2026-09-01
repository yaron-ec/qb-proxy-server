-- 2026-17-production-monitoring.sql
-- Production monitoring and safe auto-recovery schema.
--
-- Tables:
--   monitoring_incidents    — open/resolved incidents per service (crash-loop tracking)
--   monitoring_known_good   — last verified-healthy commit/deployment per service
--   monitoring_health_checks— append-only health check results (audit trail)
--
-- All tables are Railway-owned. No Base44 dependency.

CREATE TABLE IF NOT EXISTS monitoring_incidents (
  id              SERIAL PRIMARY KEY,
  service_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  failure_count   INTEGER NOT NULL DEFAULT 0,
  first_failure_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failure_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_summary TEXT,
  last_error_type    TEXT,
  alert_sent_at   TIMESTAMPTZ,
  alert_count      INTEGER NOT NULL DEFAULT 0,
  recovery_action  TEXT,  -- restart | rollback | escalate | none
  recovery_result  TEXT,
  resolved_at      TIMESTAMPTZ,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS monitoring_incidents_service_status_idx
  ON monitoring_incidents (service_id, status);

CREATE INDEX IF NOT EXISTS monitoring_incidents_last_failure_idx
  ON monitoring_incidents (last_failure_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_known_good (
  service_id      TEXT PRIMARY KEY,
  commit_sha      TEXT,
  deployment_id   TEXT,
  last_healthy_at TIMESTAMPTZ,
  health_url      TEXT,
  expected_status INTEGER DEFAULT 200,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitoring_health_checks (
  id              SERIAL PRIMARY KEY,
  service_id      TEXT NOT NULL,
  check_type      TEXT NOT NULL,  -- http | heartbeat | backlog | db
  healthy         BOOLEAN NOT NULL,
  response_time_ms INTEGER,
  http_status     INTEGER,
  details         JSONB,
  error           TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS monitoring_health_checks_service_idx
  ON monitoring_health_checks (service_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS monitoring_health_checks_unhealthy_idx
  ON monitoring_health_checks (healthy, checked_at DESC)
  WHERE healthy = false;