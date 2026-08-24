/* eslint-disable no-undef */
'use strict';
/**
 * migrateTasksToRailway.js — Idempotent task migration from Base44 to Railway.
 *
 * PREREQUISITE: migrateLeadsToRailway.js (tasks.lead_id FK → leads).
 *
 * Maps: Base44 Task.completed (boolean) → Railway tasks.status ('completed'/'pending').
 * Maps: Base44 Task.notes → Railway tasks.description.
 * Maps: Base44 Task.due_date + due_time → Railway tasks.due_date (date only).
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-tasks] Starting task migration...');
  if (!hasBase44Creds()) { console.error('[migrate-tasks] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-tasks] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Tasks = await fetchBase44Entity('Task');
  console.log(`[migrate-tasks] Fetched ${base44Tasks.length} tasks from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;
  for (let i = 0; i < base44Tasks.length; i++) {
    const task = base44Tasks[i];
    try {
      const externalRef = task.id;
      if (!externalRef) { skipped++; continue; }
      const railwayLeadId = task.lead_id ? (leadIdCache[String(task.lead_id)] || null) : null;
      if (task.lead_id && !railwayLeadId) leadNotFound++;

      const status = task.completed === true ? 'completed' : 'pending';
      const priority = 'medium'; // Base44 Task has no priority field

      const { rows } = await query(`
        INSERT INTO tasks (external_ref, lead_id, title, description, status, priority, assigned_to, due_date, completed_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = COALESCE(EXCLUDED.lead_id, tasks.lead_id),
          title = EXCLUDED.title,
          description = COALESCE(EXCLUDED.description, tasks.description),
          status = EXCLUDED.status,
          assigned_to = COALESCE(EXCLUDED.assigned_to, tasks.assigned_to),
          due_date = COALESCE(EXCLUDED.due_date, tasks.due_date),
          completed_at = COALESCE(EXCLUDED.completed_at, tasks.completed_at),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef),
        railwayLeadId,
        task.title || 'Untitled Task',
        task.notes || null,
        status,
        priority,
        task.assigned_to || null,
        task.due_date || null,
        task.completed === true ? (task.updated_date || task.created_date || null) : null,
        task.created_by_id || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
      if ((i + 1) % 500 === 0) console.log(`[migrate-tasks] Progress: ${i + 1}/${base44Tasks.length}`);
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-tasks] Error on ${task.id}: ${e.message}`);
    }
  }

  console.log(`\n=== TASK MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Tasks.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Tasks with unresolvable lead_id: ${leadNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM tasks');
  console.log(`Railway tasks table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-tasks] fatal:', e); process.exit(1); });