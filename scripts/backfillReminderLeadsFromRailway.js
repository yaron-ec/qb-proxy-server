'use strict';

const db = require('../db/client');
const { upsertLead } = require('../lib/leadIngest');

async function main() {
  const { rows } = await db.query(`
    SELECT *
    FROM leads
    WHERE external_ref IS NOT NULL
      AND (
        (follow_up_date IS NOT NULL AND follow_up_date >= CURRENT_DATE)
        OR
        (appointment_date IS NOT NULL AND appointment_date >= CURRENT_DATE)
      )
    ORDER BY external_ref
  `);

  let created = 0;
  let updated = 0;
  let failed = 0;

  console.log(`[backfill] source=${rows.length}`);
  console.log('[backfill] Railway/Postgres only — NO emails — NO reminder claims');

  for (const row of rows) {
    try {
      const result = await upsertLead(db, {
        id: row.external_ref,
        lead_first_name: row.first_name || row.lead_first_name || null,
        last_name: row.last_name || null,
        email: row.email || null,
        phone: row.phone || null,
        property_address: row.property_address || row.address || null,
        city: row.city || null,
        project_type: row.project_type || null,

        follow_up_date: row.follow_up_date || null,
        follow_up_time: row.follow_up_time || null,
        follow_up_type: row.follow_up_type || null,

        appointment_date: row.appointment_date || null,
        appointment_time: row.appointment_time || null,

        assigned_rep: row.assigned_rep || null,
        assigned_rep_name: row.assigned_rep_name || row.owner_name || null,
        assigned_rep_email: row.assigned_rep_email || row.owner_email || null,
        assigned_rep_phone: row.assigned_rep_phone || row.owner_phone || null,

        budget_range: row.budget_range || null,
        notes: row.notes || null,
        customer_reminders_disabled: Boolean(row.customer_reminders_disabled),
        crm_created_date: row.created_at || row.crm_created_date || null
      });

      if (result.action === 'created') created++;
      else updated++;
    } catch (err) {
      failed++;
      console.error(
        `[backfill] FAILED ${row.external_ref}:`,
        err.message || err
      );
    }
  }

  console.log(
    `[backfill] DONE source=${rows.length} created=${created} updated=${updated} failed=${failed}`
  );

  if (failed) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error('[backfill] FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (typeof db.end === 'function') await db.end();
      else if (db.pool && typeof db.pool.end === 'function') await db.pool.end();
    } catch {}
  });
