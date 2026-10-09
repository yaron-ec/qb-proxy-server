-- Extends platform_companies with fully-automated Railway infrastructure
-- provisioning + centrally-managed release tracking (PRODUCTIZATION —
-- Company Provisioning System, automated infrastructure + release pipeline).
--
-- All new columns are additive and nullable — a company provisioned through
-- the ORIGINAL manual flow (PR #24: admin pastes a database_url) is
-- completely unaffected; these columns simply stay NULL for it, and it keeps
-- working exactly as before. They are populated only for a company
-- provisioned through the new automated path (lib/platformInfraProvisioning.js).
ALTER TABLE platform_companies
  ADD COLUMN IF NOT EXISTS railway_project_id      TEXT,
  ADD COLUMN IF NOT EXISTS railway_environment_id   TEXT,
  -- { api: "<serviceId>", frontend: "<serviceId>", "reminder-worker": "<serviceId>", "calendar-outbox-worker": "<serviceId>" }
  ADD COLUMN IF NOT EXISTS railway_service_ids      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The git branch (in THIS shared repo — never a per-company fork/repo) each
  -- of the company's Railway services is connected to. Deploys are driven by
  -- advancing this ref's commit, NOT by the company tracking `main` directly
  -- — this is what makes rollout "centrally managed" rather than "every
  -- company redeploys the instant anyone pushes to main".
  ADD COLUMN IF NOT EXISTS deploy_branch            TEXT,
  ADD COLUMN IF NOT EXISTS current_release_sha      TEXT,
  ADD COLUMN IF NOT EXISTS last_deploy_status       TEXT,
  ADD COLUMN IF NOT EXISTS last_deploy_at           TIMESTAMPTZ,
  -- Resumability: { step: "railway_project" | "railway_environment" |
  -- "postgres" | "services" | "variables" | "domains" | "deploy" |
  -- "health_check" | "database" | "invite" | "done", completed_steps: [...],
  -- updated_at }. provisionInfrastructure() reads this before each step and
  -- skips whatever is already recorded done — a retry after a failure never
  -- re-creates a Railway resource that already exists.
  ADD COLUMN IF NOT EXISTS provisioning_state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cost_estimate_monthly_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cost_estimate_breakdown  JSONB,
  ADD COLUMN IF NOT EXISTS cost_confirmed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cost_confirmed_by         UUID REFERENCES users(id);

-- 'provisioning_failed' is a new, retryable terminal state distinct from the
-- original 'failed' (which the manual /infrastructure path already used for
-- a DB-provisioning failure) — kept separate so the UI can label "retry
-- automated provisioning" differently from "re-paste infrastructure
-- details by hand".
ALTER TABLE platform_companies DROP CONSTRAINT IF EXISTS platform_companies_status_check;
ALTER TABLE platform_companies ADD CONSTRAINT platform_companies_status_check
  CHECK (status IN ('draft','awaiting_infrastructure','provisioning','provisioning_failed','ready_to_invite','invited','activated','suspended','failed'));

-- platform_releases — one row per "vetted, deployable version of the shared
-- codebase" the platform admin has chosen to roll out. Created from THIS
-- server's own RAILWAY_GIT_COMMIT_SHA (the commit Railway actually deployed
-- to EC's own production instance via the existing, unchanged main-branch
-- pipeline) by default — "roll out what I'm already running", never an
-- arbitrary/unvetted sha.
CREATE TABLE IF NOT EXISTS platform_releases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  git_sha           TEXT NOT NULL,
  git_ref           TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','rolling_out','completed','halted','rolled_back')),
  batch_size        INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- platform_company_deployments — append-only audit trail of every rollout/
-- rollback action taken against a single company's deploy branch. The
-- previous_release_sha on the most recent row for a company is exactly what
-- a rollback moves that company's deploy branch back to.
CREATE TABLE IF NOT EXISTS platform_company_deployments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES platform_companies(id),
  release_id           UUID REFERENCES platform_releases(id),
  previous_release_sha TEXT,
  target_release_sha   TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','deployed','healthy','failed','rolled_back')),
  health_detail        JSONB,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS platform_company_deployments_company_idx ON platform_company_deployments (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_company_deployments_release_idx ON platform_company_deployments (release_id);
