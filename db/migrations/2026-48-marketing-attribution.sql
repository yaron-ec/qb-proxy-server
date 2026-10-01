-- 2026-48-marketing-attribution.sql
--
-- Growth Engine Phase 1 — durable marketing attribution + funnel history.
--
-- Separates three things that were previously conflated or lost:
--
--   PERSON / LEAD        leads                (unchanged meaning)
--   INQUIRY / SUBMISSION lead_submissions     (existing table, extended: one
--                                             row per form submission / inquiry,
--                                             idempotent on external_ref)
--   MARKETING TOUCH      marketing_touches    (new: append-only, timestamped,
--                                             one row per distinct visit/click)
--
-- and records funnel history that was previously overwritten in place:
--
--   lead_status_events          every change of leads.status, written by a
--                               trigger so EVERY writer is covered
--   lead_qualification_events   explicit, versioned Qualified decisions
--                               (Qualified is a marketing attribute, NOT a
--                               lead status — never inferred historically)
--
-- Channel normalization keeps three layers apart:
--   raw source        leads.source / lead_submissions.raw_source (never rewritten)
--   normalized channel marketing_channels (generic taxonomy)
--   lead provider     lead_providers (people / partners — NOT channels,
--                     NOT CRM users)
-- linked by lead_source_mappings (raw value → channel + optional provider),
-- maintained as data (scripts/marketing/applySourceMappings.js), so legacy
-- values stay auditable and nothing installation-specific is in code.
--
-- Merge lineage: leads.merged_into_lead_id / merged_at (routes/mergeLeads.js
-- previously wrote three columns that never existed — see Phase 0 report).
--
-- Purely ADDITIVE and startup-safe: new tables, nullable columns without
-- defaults (no table rewrite), IF NOT EXISTS / OR REPLACE everywhere, no
-- existing row is modified. Idempotent; safe to re-run.

-- ── 1. Channel taxonomy (generic, installation-agnostic) ────────────────────
CREATE TABLE IF NOT EXISTS marketing_channels (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  is_paid     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  description TEXT
);

INSERT INTO marketing_channels (code, label, is_paid, sort_order, description) VALUES
  ('organic_search',          'Organic Search',                                FALSE, 10, 'Unpaid search engine visit with no Business Profile evidence (non-Google engines, or explicitly tagged organic).'),
  ('google_organic_or_gbp',   'Google Search — organic or Business Profile',    FALSE, 15, 'Google referrer with no campaign tagging: organic results and untagged Business Profile website clicks are indistinguishable. Never guessed as either.'),
  ('google_business_profile', 'Google Business Profile / Maps',                 FALSE, 20, 'Only when explicitly tagged (e.g. utm_source=gbp / utm_medium=gbp).'),
  ('google_ads',              'Google Ads',                                     TRUE,  30, 'gclid / gbraid / wbraid / gad_source, or utm_source=google with a paid medium.'),
  ('local_services_ads',      'Local Services Ads',                             TRUE,  40, 'Only when explicitly tagged (utm_source=lsa or utm_medium=lsa).'),
  ('microsoft_ads',           'Microsoft / Bing Ads',                           TRUE,  50, 'msclkid, or utm_source=bing/microsoft with a paid medium.'),
  ('meta',                    'Meta (Facebook / Instagram)',                    FALSE, 60, 'fbclid or utm_source=facebook/instagram/meta, or Meta Lead Ads.'),
  ('direct',                  'Direct',                                         FALSE, 70, 'No referrer and no campaign parameters.'),
  ('referral',                'Referral',                                       FALSE, 80, 'External website referrer, or a referral recorded by staff.'),
  ('partner',                 'Partner / Lead Provider',                        FALSE, 85, 'A lead provider (person or partner) supplied the lead. The provider itself is in lead_providers.'),
  ('offline',                 'Offline',                                        FALSE, 90, 'Print, direct mail, signage, radio/TV, events — when tagged.'),
  ('other',                   'Other',                                          FALSE, 95, 'Known but not one of the above.'),
  ('unknown',                 'Unknown',                                        FALSE, 99, 'Insufficient evidence. Preferred over a guess.')
ON CONFLICT (code) DO NOTHING;

-- ── 2. Lead providers (people / partners who supply leads) ──────────────────
-- NOT marketing channels and NOT CRM users (no FK to users/owners).
CREATE TABLE IF NOT EXISTS lead_providers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'partner' CHECK (kind IN ('partner','referral_source','other')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_providers_name_uidx ON lead_providers (lower(name));

-- ── 3. Raw source → channel / provider mapping (data, auditable) ────────────
-- raw_source_key = lower(trim(raw value)). Unmapped raw values resolve to
-- 'unknown' in lead_attribution_v; leads.source is never rewritten.
CREATE TABLE IF NOT EXISTS lead_source_mappings (
  raw_source_key TEXT PRIMARY KEY,
  raw_source     TEXT NOT NULL,
  channel_code   TEXT NOT NULL REFERENCES marketing_channels(code),
  provider_id    UUID REFERENCES lead_providers(id),
  notes          TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. Merge lineage on leads ───────────────────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_into_lead_id UUID;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS leads_merged_into_idx ON leads (merged_into_lead_id) WHERE merged_into_lead_id IS NOT NULL;

-- ── 5. Marketing touches (append-only) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_touches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  touch_type          TEXT NOT NULL DEFAULT 'web_visit' CHECK (touch_type IN ('web_visit','lead_ad','manual','call')),
  occurred_at         TIMESTAMPTZ NOT NULL,           -- landing/click time, not insert time
  origin_system       TEXT NOT NULL,                  -- website | meta | capture | manual | ...
  content_hash        TEXT NOT NULL,                  -- idempotency: identical touch → one row per lead
  channel_code        TEXT NOT NULL REFERENCES marketing_channels(code),
  classifier_version  TEXT NOT NULL,
  source              TEXT,                           -- utm_source, else derived from evidence
  medium              TEXT,                           -- utm_medium, else derived from evidence
  campaign            TEXT,
  campaign_id         TEXT,                           -- gad_campaignid / utm_id when present
  ad_group            TEXT,
  ad_group_id         TEXT,
  keyword             TEXT,                           -- only from an explicit source (never inferred)
  landing_page        TEXT,
  referrer            TEXT,                           -- scheme://host/path of an external referrer
  utm_source          TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, utm_id TEXT,
  gclid               TEXT, gbraid TEXT, wbraid TEXT, msclkid TEXT, fbclid TEXT,
  gad_source          TEXT, gad_campaignid TEXT,
  merged_from_lead_id UUID,                           -- set when moved by a lead merge
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_touches_lead_hash_uidx
  ON marketing_touches (lead_id, content_hash) WHERE merged_from_lead_id IS NULL;
CREATE INDEX IF NOT EXISTS marketing_touches_lead_idx ON marketing_touches (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS marketing_touches_channel_idx ON marketing_touches (channel_code, occurred_at);
CREATE INDEX IF NOT EXISTS marketing_touches_gclid_idx ON marketing_touches (gclid) WHERE gclid IS NOT NULL;

-- Lead-level pointers. first_touch_id is immutable once set (trigger below);
-- last_touch_id = last MEANINGFUL (non-direct) touch; conversion_touch_id =
-- the touch of the inquiry that created the lead (set once, in code).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversion_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;

-- ── 6. lead_submissions = canonical per-inquiry history (extended) ──────────
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS origin_system TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS intake_action TEXT;          -- created | matched_existing | created_possible_duplicate
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS raw_source TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS website_lead_id TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS website_submission_id TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS page_url TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS conversion_page TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS first_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS last_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS conversion_touch_id UUID REFERENCES marketing_touches(id) ON DELETE SET NULL;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS consent_sms BOOLEAN;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS consent_email BOOLEAN;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS consent_gpc BOOLEAN;          -- browser Global Privacy Control signal at submission
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS merged_from_lead_id UUID;

-- ── 7. Lead status history (trigger-written: covers every writer) ───────────
CREATE TABLE IF NOT EXISTS lead_status_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status         TEXT,
  to_status           TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor               TEXT,           -- current_setting('ec.actor') when the writer set it
  change_source       TEXT,           -- current_setting('ec.change_source')
  reason              TEXT,           -- current_setting('ec.status_reason'), e.g. 'merged_duplicate'
  merged_from_lead_id UUID
);
CREATE INDEX IF NOT EXISTS lead_status_events_lead_idx ON lead_status_events (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS lead_status_events_to_idx ON lead_status_events (lower(to_status), occurred_at);

CREATE OR REPLACE FUNCTION ec_record_lead_status_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO lead_status_events (lead_id, from_status, to_status, actor, change_source, reason)
    VALUES (NEW.id,
            CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
            NEW.status,
            NULLIF(current_setting('ec.actor', true), ''),
            NULLIF(current_setting('ec.change_source', true), ''),
            NULLIF(current_setting('ec.status_reason', true), ''));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_status_history ON leads;
CREATE TRIGGER leads_status_history
  AFTER INSERT OR UPDATE OF status ON leads
  FOR EACH ROW EXECUTE FUNCTION ec_record_lead_status_event();

-- ── 8. First-touch immutability ─────────────────────────────────────────────
-- Once set, leads.first_touch_id changes only through an explicit, audited
-- correction (lib/marketing/attributionStore.js#correctFirstTouch sets
-- ec.attribution_correction = 'on' for its own transaction and writes
-- lead_attribution_audit).
CREATE TABLE IF NOT EXISTS lead_attribution_audit (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,     -- first_touch_correction | merge_adopted_first_touch | merge_moved_touches
  previous_touch_id UUID,
  new_touch_id      UUID,
  actor             TEXT,
  reason            TEXT,
  details           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lead_attribution_audit_lead_idx ON lead_attribution_audit (lead_id, created_at);

CREATE OR REPLACE FUNCTION ec_guard_first_touch() RETURNS trigger AS $$
BEGIN
  -- Allowed: an audited correction, or the FK clearing the pointer because
  -- the touch itself was deleted together with the lead that owned it.
  IF OLD.first_touch_id IS NOT NULL
     AND NEW.first_touch_id IS DISTINCT FROM OLD.first_touch_id
     AND COALESCE(current_setting('ec.attribution_correction', true), '') <> 'on'
     AND NOT (NEW.first_touch_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM marketing_touches WHERE id = OLD.first_touch_id)) THEN
    RAISE EXCEPTION 'first_touch_id of lead % is immutable (use an audited correction)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_first_touch_guard ON leads;
CREATE TRIGGER leads_first_touch_guard
  BEFORE UPDATE OF first_touch_id ON leads
  FOR EACH ROW EXECUTE FUNCTION ec_guard_first_touch();

-- ── 9. Qualification (marketing attribute, versioned, never inferred) ───────
CREATE TABLE IF NOT EXISTS lead_qualification_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  outcome             TEXT NOT NULL CHECK (outcome IN ('qualified','not_qualified')),
  definition_version  TEXT NOT NULL,
  criteria            JSONB NOT NULL,
  decided_by          TEXT,
  decision_source     TEXT NOT NULL DEFAULT 'manual' CHECK (decision_source IN ('manual','rule')),
  notes               TEXT,
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key     TEXT,
  merged_from_lead_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_qualification_events_idem_uidx
  ON lead_qualification_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_qualification_events_lead_idx ON lead_qualification_events (lead_id, decided_at);

-- ── 10. Read models ─────────────────────────────────────────────────────────
-- Attribution per lead: raw source, mapped channel/provider, touch channels.
-- normalized_channel precedence: last meaningful touch → conversion touch →
-- first touch → raw-source mapping → 'unknown'. Never a guess.
CREATE OR REPLACE VIEW lead_attribution_v AS
SELECT
  l.id                                   AS lead_id,
  l.source                               AS raw_source,
  m.channel_code                         AS source_mapping_channel,
  m.provider_id                          AS provider_id,
  p.name                                 AS provider_name,
  ft.channel_code                        AS first_touch_channel,
  lt.channel_code                        AS last_touch_channel,
  ct.channel_code                        AS conversion_touch_channel,
  COALESCE(lt.channel_code, ct.channel_code, ft.channel_code, m.channel_code, 'unknown') AS normalized_channel,
  CASE
    WHEN lt.id IS NOT NULL OR ct.id IS NOT NULL OR ft.id IS NOT NULL THEN 'touch'
    WHEN m.channel_code IS NOT NULL THEN 'source_mapping'
    ELSE 'none'
  END                                    AS channel_basis,
  ft.occurred_at AS first_touch_at, ft.landing_page AS first_landing_page, ft.referrer AS first_referrer,
  ft.source AS first_source, ft.medium AS first_medium, ft.campaign AS first_campaign,
  lt.occurred_at AS last_touch_at, lt.landing_page AS last_landing_page,
  lt.source AS last_source, lt.medium AS last_medium, lt.campaign AS last_campaign, lt.campaign_id AS last_campaign_id,
  ct.occurred_at AS conversion_touch_at, ct.landing_page AS conversion_landing_page,
  COALESCE(lt.gclid, ft.gclid)   AS gclid,
  COALESCE(lt.gbraid, ft.gbraid) AS gbraid,
  COALESCE(lt.wbraid, ft.wbraid) AS wbraid,
  COALESCE(lt.msclkid, ft.msclkid) AS msclkid,
  COALESCE(lt.fbclid, ft.fbclid) AS fbclid
FROM leads l
LEFT JOIN lead_source_mappings m ON m.raw_source_key = lower(btrim(l.source))
LEFT JOIN lead_providers p ON p.id = m.provider_id
LEFT JOIN marketing_touches ft ON ft.id = l.first_touch_id
LEFT JOIN marketing_touches lt ON lt.id = l.last_touch_id
LEFT JOIN marketing_touches ct ON ct.id = l.conversion_touch_id
WHERE l.merged_into_lead_id IS NULL;

-- Funnel per lead: first time each stage was reached, from the canonical
-- records that already exist (appointments, estimates, Handoff, deals,
-- SignNow) plus the new status history. Qualified only from explicit
-- qualification events. Stage evidence is never fabricated.
CREATE OR REPLACE VIEW lead_funnel_v AS
WITH st AS (
  SELECT lead_id,
         MIN(occurred_at) FILTER (WHERE lower(btrim(to_status)) = 'appointment scheduled') AS status_appt_at,
         MIN(occurred_at) FILTER (WHERE lower(btrim(to_status)) = 'proposal sent')         AS status_estimate_at,
         MIN(occurred_at) FILTER (WHERE lower(btrim(to_status)) = 'sold')                  AS status_sold_at
    FROM lead_status_events
   WHERE reason IS DISTINCT FROM 'merged_duplicate'
   GROUP BY lead_id
)
SELECT
  l.id AS lead_id,
  COALESCE(l.crm_created_date, l.created_at) AS lead_created_at,
  (SELECT MIN(q.decided_at) FROM lead_qualification_events q
    WHERE q.lead_id = l.id AND q.outcome = 'qualified') AS qualified_at,
  LEAST(
    (SELECT MIN(a.created_at) FROM appointments a
      WHERE a.lead_id = l.id AND lower(a.busy_range) < a.start_at),   -- real appointment (Meeting-shaped), never a Phone Call
    st.status_appt_at
  ) AS appointment_at,
  LEAST(
    (SELECT MIN(e.created_at) FROM estimates e WHERE e.lead_id = l.id AND e.status IS DISTINCT FROM 'Draft'),
    (SELECT MIN(h.estimate_date)::timestamptz FROM handoff_estimates h
      WHERE h.lead_id = l.id AND h.match_status = 'matched' AND h.match_method IN ('name_phone','name_email')),
    st.status_estimate_at
  ) AS estimate_at,
  LEAST(
    (SELECT MIN(COALESCE(d.sold_date, d.created_at)) FROM deals d WHERE d.lead_id = l.id),
    (SELECT MIN(s.signed_at) FROM signnow_documents s
      WHERE s.lead_id = l.id AND s.status IN ('signed','completed')
        AND (lower(s.document_name) LIKE '%hic%' OR lower(s.document_name) LIKE '%home improvement contract%')),
    st.status_sold_at
  ) AS sold_at,
  (SELECT MAX(COALESCE(d.contract_amount, d.amount)) FROM deals d WHERE d.lead_id = l.id) AS sold_value
FROM leads l
LEFT JOIN st ON st.lead_id = l.id
WHERE l.merged_into_lead_id IS NULL;
