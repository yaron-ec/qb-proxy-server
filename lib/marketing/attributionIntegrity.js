/* eslint-disable no-undef */
/**
 * attributionIntegrity — READ-ONLY aggregate checks for the Growth Engine
 * foundation and the Phase 0 defects, served by GET /api/v1/system/
 * attribution-integrity (routes/systemHealth.js; admin JWT or the website
 * repo's final-verify OIDC identity). Every query is a SELECT; output is
 * counts, booleans and status labels only — never a name, contact detail,
 * click identifier or other per-lead value.
 */
'use strict';
const { CANONICAL_LEAD_STATUSES } = require('../leadStatus');

async function columnsPresent(db, table, cols) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  const have = new Set(rows.map((r) => r.column_name));
  return Object.fromEntries(cols.map((c) => [c, have.has(c)]));
}

const MAIN_CONTRACT_SQL = `(lower(s.document_name) LIKE '%hic%' OR lower(s.document_name) LIKE '%home improvement contract%')`;

async function attributionIntegrity(db) {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await db.query(sql, params)).rows;

  const signnowSold = await one(`
    SELECT COUNT(*)::int AS main_contracts_signed,
           COUNT(*) FILTER (WHERE l.id IS NOT NULL AND l.status IS DISTINCT FROM 'Sold')::int AS lead_not_sold,
           COUNT(*) FILTER (WHERE l.id IS NOT NULL AND l.status IS DISTINCT FROM 'Sold'
                              AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id))::int AS lead_not_sold_and_no_deal,
           COUNT(*) FILTER (WHERE l.id IS NOT NULL AND l.status IS DISTINCT FROM 'Sold' AND EXISTS (
                SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.author = 'SignNow (auto)'
                   AND a.content LIKE '%Lead automatically marked as Sold%'))::int AS activity_claims_sold_but_lead_not_sold,
           MIN(s.signed_at) FILTER (WHERE l.status IS DISTINCT FROM 'Sold') AS earliest_affected_signed_at,
           MAX(s.signed_at) FILTER (WHERE l.status IS DISTINCT FROM 'Sold') AS latest_affected_signed_at
      FROM signnow_documents s LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.status IN ('signed','completed') AND ${MAIN_CONTRACT_SQL}`);

  const statuses = await all(`SELECT status, COUNT(*)::int AS n FROM leads WHERE merged_into_lead_id IS NULL GROUP BY status ORDER BY n DESC`);
  const statusValues = statuses.map((r) => ({ status: r.status, n: r.n, canonical: CANONICAL_LEAD_STATUSES.includes(r.status) }));

  const attribution = await one(`
    SELECT COUNT(*) FILTER (WHERE l.source = 'Website')::int AS website_leads,
           COUNT(*) FILTER (WHERE l.source = 'Website' AND l.first_touch_id IS NOT NULL)::int AS website_leads_with_first_touch,
           COUNT(*) FILTER (WHERE l.first_touch_id IS NOT NULL)::int AS leads_with_first_touch,
           COUNT(*) FILTER (WHERE l.last_touch_id IS NOT NULL)::int AS leads_with_last_meaningful_touch,
           COUNT(*) FILTER (WHERE l.conversion_touch_id IS NOT NULL)::int AS leads_with_conversion_touch,
           COUNT(*) FILTER (WHERE l.merged_into_lead_id IS NOT NULL)::int AS merged_leads
      FROM leads l`);
  const touches = await one(`
    SELECT COUNT(*)::int AS touches,
           COUNT(*) FILTER (WHERE gclid IS NOT NULL)::int AS with_gclid,
           COUNT(*) FILTER (WHERE gbraid IS NOT NULL OR wbraid IS NOT NULL)::int AS with_gbraid_or_wbraid,
           COUNT(*) FILTER (WHERE msclkid IS NOT NULL)::int AS with_msclkid,
           COUNT(*) FILTER (WHERE merged_from_lead_id IS NOT NULL)::int AS moved_by_merge
      FROM marketing_touches`);
  const byChannel = await all(`SELECT channel_code, COUNT(*)::int AS n FROM marketing_touches GROUP BY channel_code ORDER BY n DESC`);
  const history = await one(`
    SELECT (SELECT COUNT(*)::int FROM lead_submissions) AS submissions,
           (SELECT COUNT(*)::int FROM lead_submissions WHERE origin_system = 'website') AS website_submissions,
           (SELECT COUNT(*)::int FROM lead_status_events) AS status_events,
           (SELECT COUNT(*)::int FROM lead_qualification_events) AS qualification_events,
           (SELECT COUNT(*)::int FROM lead_source_mappings) AS source_mappings,
           (SELECT COUNT(*)::int FROM lead_providers) AS lead_providers`);
  const unmappedSources = await one(`
    SELECT COUNT(DISTINCT lower(btrim(l.source)))::int AS distinct_unmapped_sources
      FROM leads l LEFT JOIN lead_source_mappings m ON m.raw_source_key = lower(btrim(l.source))
     WHERE l.source IS NOT NULL AND btrim(l.source) <> '' AND m.raw_source_key IS NULL AND l.source <> 'Website'`);

  // Stored raw source labels (staff-picked list values such as "Referral" or a
  // provider's name) with counts and the current mapping, so the mapping table
  // can be approved against production reality. Values used by a single lead
  // are only counted (a one-off free-text value could contain anything);
  // labels are trimmed to 60 characters.
  const rawSourceRows = await all(`
    SELECT l.source AS raw_source, COUNT(*)::int AS n, m.channel_code AS mapped_channel, (p.name IS NOT NULL) AS has_provider
      FROM leads l
      LEFT JOIN lead_source_mappings m ON m.raw_source_key = lower(btrim(l.source))
      LEFT JOIN lead_providers p ON p.id = m.provider_id
     WHERE l.merged_into_lead_id IS NULL
     GROUP BY l.source, m.channel_code, p.name
     ORDER BY n DESC`);
  const rawSources = {
    values: rawSourceRows.filter((r) => r.n >= 2).slice(0, 100)
      .map((r) => ({ raw_source: r.raw_source == null ? null : String(r.raw_source).slice(0, 60), n: r.n, mapped_channel: r.mapped_channel || null, has_provider: r.has_provider })),
    single_use_values: rawSourceRows.filter((r) => r.n < 2).length,
  };

  return {
    raw_sources: rawSources,
    generated_at: new Date().toISOString(),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    schema: {
      // The columns routes/signnowWebhook.js and routes/mergeLeads.js used to
      // write. false = the old code path could never have succeeded here.
      legacy_signnow_lead_columns: await columnsPresent(db, 'leads', ['signed_contract_date', 'signed_contract_document_id', 'sold_date', 'sold_by_source']),
      legacy_merge_lead_columns: await columnsPresent(db, 'leads', ['duplicate_merged', 'last_merge_date', 'merge_count']),
      // Former QuickBooks / Handoff writes (qbInboundSync, leadQB, handoffSync,
      // server.js QB direct sync) — removed or redirected to canonical columns.
      legacy_qb_handoff_lead_columns: await columnsPresent(db, 'leads', ['qb_last_error', 'handoff_estimate_status', 'appointment_date', 'handoff_project_id', 'handoff_project_number']),
      attribution_columns: await columnsPresent(db, 'leads', ['first_touch_id', 'last_touch_id', 'conversion_touch_id', 'merged_into_lead_id']),
    },
    signnow_sold: signnowSold,
    lead_status: {
      values: statusValues,
      non_canonical_rows: statusValues.filter((v) => !v.canonical).reduce((a, v) => a + v.n, 0),
      appointment_scheduled_capital_s_rows: (statuses.find((r) => r.status === 'Appointment Scheduled') || { n: 0 }).n,
    },
    attribution: { ...attribution, ...touches, touches_by_channel: byChannel, ...unmappedSources },
    history,
  };
}

module.exports = { attributionIntegrity };
