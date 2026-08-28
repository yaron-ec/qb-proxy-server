/* eslint-disable no-undef */
'use strict';
/**
 * systemWideReconciliation.js — READ-ONLY system-wide reconciliation.
 *
 * Fetches current Base44 source counts AND current Railway destination counts,
 * compares them, checks FK integrity, admin roles, owner mappings, Simon identity,
 * duplicates, and recent Base44 deltas. Zero writes. Safe to run any time.
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for migrationReader).
 */
const { query, pool } = require('../db/client');
const { countBase44Entity, fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

const MIGRATION_CUTOVER_DATE = new Date('2026-08-27T00:00:00Z');

async function safeCount(table) {
  try {
    const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${table}`);
    return parseInt(rows[0].cnt, 10);
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function main() {
  const report = { timestamp: new Date().toISOString(), migration_cutover: MIGRATION_CUTOVER_DATE.toISOString() };

  // ── 1. Base44 source counts ──────────────────────────────────────────────
  const b44Entities = ['Lead', 'Activity', 'Deal', 'DealExpense', 'Invoice', 'Task',
    'Estimate', 'HandoffEstimate', 'LeadSubmission', 'SignNowDocument',
    'UserAllowlist', 'CompanySettings', 'SyncCursor', 'LeadAttachment'];
  const b44Counts = {};
  for (const e of b44Entities) {
    const result = await countBase44Entity(e);
    b44Counts[e] = result.count;
  }
  report.base44_counts = b44Counts;

  // ── 2. Railway destination counts ────────────────────────────────────────
  const railTables = ['leads', 'appointments', 'activities', 'deals', 'deal_expenses',
    'invoices', 'tasks', 'estimates', 'handoff_estimates', 'lead_submissions',
    'signnow_documents', 'user_allowlist', 'company_settings', 'sync_cursors',
    'lead_attachments'];
  const railCounts = {};
  for (const t of railTables) {
    railCounts[t] = await safeCount(t);
  }
  report.railway_counts = railCounts;

  // ── 3. Admin verification (owners table + user_allowlist for roles) ────────
  const { rows: owners } = await query(
    `SELECT id, display_name, email, is_active FROM owners WHERE is_active = true ORDER BY display_name`
  );
  report.owners = owners;

  const { rows: allowlistRoles } = await query(
    `SELECT email, name, role, enabled FROM user_allowlist ORDER BY email`
  );
  const yaronOwner = owners.find(a => a.display_name && a.display_name.toLowerCase().includes('yaron'));
  const michelleOwner = owners.find(a => a.display_name && a.display_name.toLowerCase().includes('michelle'));
  const yaronAllow = allowlistRoles.find(a => a.email && a.email.toLowerCase().includes('yaron'));
  const michelleAllow = allowlistRoles.find(a => a.email && a.email.toLowerCase().includes('michelle'));
  report.admin_verification = {
    yaron_owner_exists: !!yaronOwner,
    yaron_owner_record: yaronOwner,
    yaron_allowlist_role: yaronAllow?.role,
    yaron_allowlist_enabled: yaronAllow?.enabled,
    yaron_is_admin: yaronAllow?.role === 'admin' && yaronAllow?.enabled !== false,
    michelle_owner_exists: !!michelleOwner,
    michelle_owner_record: michelleOwner,
    michelle_allowlist_role: michelleAllow?.role,
    michelle_allowlist_enabled: michelleAllow?.enabled,
    michelle_is_admin: michelleAllow?.role === 'admin' && michelleAllow?.enabled !== false,
  };

  // ── 4. Simon / Shlomi identity ───────────────────────────────────────────
  const { rows: simonShlomiOwners } = await query(
    `SELECT id, display_name, email, is_active FROM owners WHERE lower(display_name) LIKE '%simon%' OR lower(display_name) LIKE '%shlomi%'`
  );
  const simonShlomiAllow = allowlistRoles.filter(a =>
    (a.email && (a.email.toLowerCase().includes('simon') || a.email.toLowerCase().includes('shlomi'))) ||
    (a.name && (a.name.toLowerCase().includes('simon') || a.name.toLowerCase().includes('shlomi')))
  );
  report.simon_shlomi_identity = { owners: simonShlomiOwners, allowlist: simonShlomiAllow };

  // ── 5. Owner mapping coverage ────────────────────────────────────────────
  const { rows: ownerStats } = await query(`
    SELECT
      COUNT(*) as total_leads,
      COUNT(owner_id) as leads_with_owner,
      COUNT(*) - COUNT(owner_id) as leads_without_owner
    FROM leads
  `);
  report.owner_mapping = ownerStats[0];

  // ── 6. Duplicate detection ────────────────────────────────────────────────
  const { rows: dupEmails } = await query(
    `SELECT lower(email) as email, count(*) as cnt, array_agg(id) as lead_ids
     FROM leads WHERE email IS NOT NULL AND email != ''
     GROUP BY lower(email) HAVING count(*) > 1 LIMIT 20`
  );
  report.duplicate_leads_by_email = dupEmails;

  const { rows: dupPhones } = await query(
    `SELECT phone, count(*) as cnt, array_agg(id) as lead_ids
     FROM leads WHERE phone IS NOT NULL AND phone != ''
     GROUP BY phone HAVING count(*) > 1 LIMIT 20`
  );
  report.duplicate_leads_by_phone = dupPhones;

  const { rows: dupDeals } = await query(
    `SELECT lead_id, count(*) as cnt, array_agg(id) as deal_ids
     FROM deals WHERE lead_id IS NOT NULL
     GROUP BY lead_id HAVING count(*) > 1 LIMIT 20`
  );
  report.duplicate_deals_by_lead = dupDeals;

  // ── 7. FK integrity checks ────────────────────────────────────────────────
  const fkChecks = {};
  const fkQueries = [
    ['activities', `SELECT COUNT(*) as cnt FROM activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.lead_id IS NOT NULL AND l.id IS NULL`],
    ['appointments', `SELECT COUNT(*) as cnt FROM appointments ap LEFT JOIN leads l ON l.id = ap.lead_id WHERE ap.lead_id IS NOT NULL AND l.id IS NULL`],
    ['deals', `SELECT COUNT(*) as cnt FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.lead_id IS NOT NULL AND l.id IS NULL`],
    ['estimates', `SELECT COUNT(*) as cnt FROM estimates e LEFT JOIN leads l ON l.id = e.lead_id WHERE e.lead_id IS NOT NULL AND l.id IS NULL`],
    ['invoices', `SELECT COUNT(*) as cnt FROM invoices i LEFT JOIN leads l ON l.id = i.lead_id WHERE i.lead_id IS NOT NULL AND l.id IS NULL`],
    ['tasks', `SELECT COUNT(*) as cnt FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.lead_id IS NOT NULL AND l.id IS NULL`],
    ['signnow_documents', `SELECT COUNT(*) as cnt FROM signnow_documents s LEFT JOIN leads l ON l.id = s.lead_id WHERE s.lead_id IS NOT NULL AND l.id IS NULL`],
    ['lead_submissions', `SELECT COUNT(*) as cnt FROM lead_submissions ls LEFT JOIN leads l ON l.id = ls.lead_id WHERE ls.lead_id IS NOT NULL AND l.id IS NULL`],
    ['handoff_estimates', `SELECT COUNT(*) as cnt FROM handoff_estimates he LEFT JOIN leads l ON l.id = he.lead_id WHERE he.lead_id IS NOT NULL AND l.id IS NULL`],
    ['lead_attachments', `SELECT COUNT(*) as cnt FROM lead_attachments la LEFT JOIN leads l ON l.id = la.lead_id WHERE la.lead_id IS NOT NULL AND l.id IS NULL`],
    ['deal_expenses', `SELECT COUNT(*) as cnt FROM deal_expenses de LEFT JOIN deals d ON d.id = de.deal_id WHERE de.deal_id IS NOT NULL AND d.id IS NULL`],
  ];
  for (const [name, sql] of fkQueries) {
    try {
      const { rows } = await query(sql);
      fkChecks[name] = parseInt(rows[0].cnt, 10);
    } catch (e) {
      fkChecks[name] = `ERROR: ${e.message}`;
    }
  }
  report.fk_integrity = fkChecks;

  // ── 8. External_ref coverage (idempotency key presence) ──────────────────
  const extRefChecks = {};
  const extRefTables = ['activities', 'deals', 'estimates', 'invoices', 'tasks',
    'signnow_documents', 'lead_submissions', 'handoff_estimates', 'lead_attachments',
    'deal_expenses', 'sync_cursors', 'user_allowlist', 'company_settings'];
  for (const t of extRefTables) {
    try {
      const total = await safeCount(t);
      let withRef = 0;
      try {
        const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${t} WHERE external_ref IS NOT NULL`);
        withRef = parseInt(rows[0].cnt, 10);
      } catch (e) {
        // table might not have external_ref column
      }
      extRefChecks[t] = { total, with_external_ref: withRef, without: total - withRef };
    } catch (e) {
      extRefChecks[t] = `ERROR: ${e.message}`;
    }
  }
  report.external_ref_coverage = extRefChecks;

  // ── 9. Recent Base44 deltas (records updated after cutover) ────────────────
  const deltas = {};
  for (const entity of b44Entities) {
    try {
      const records = await fetchBase44Entity(entity);
      const recent = records.filter(r => {
        const updated = r.updated_date ? new Date(r.updated_date) : null;
        const created = r.created_date ? new Date(r.created_date) : null;
        return (updated && updated > MIGRATION_CUTOVER_DATE) || (created && created > MIGRATION_CUTOVER_DATE);
      });
      if (recent.length > 0) {
        deltas[entity] = {
          count: recent.length,
          sample_ids: recent.slice(0, 5).map(r => r.id),
          max_updated: recent.reduce((max, r) => {
            const u = r.updated_date ? new Date(r.updated_date) : new Date(r.created_date || 0);
            return u > max ? u : max;
          }, new Date(0)).toISOString(),
        };
      } else {
        deltas[entity] = { count: 0 };
      }
    } catch (e) {
      deltas[entity] = `ERROR: ${e.message}`;
    }
  }
  report.base44_deltas_since_cutover = deltas;

  // ── 10. Railway-only records (no Base44 counterpart) ───────────────────────
  const railOnly = {};
  // Leads with no external_ref (Railway-native, not from Base44)
  try {
    const { rows: noExtRefLeads } = await query(
      `SELECT COUNT(*) as cnt FROM leads WHERE external_ref IS NULL`
    );
    railOnly.leads_without_external_ref = parseInt(noExtRefLeads[0].cnt, 10);
  } catch (e) { railOnly.leads_without_external_ref = `ERROR: ${e.message}`; }

  // ── 11. User allowlist state (already fetched in section 3) ──────────────
  report.user_allowlist = allowlistRoles;

  // ── Output ────────────────────────────────────────────────────────────────
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  return report;
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main };