'use strict';

const db = require('../db/client');
const { upsertLead } = require('../lib/leadIngest');

function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validFutureDate(value, today) {
  if (!value) return false;

  const date = String(value).slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  return date >= today;
}

async function main() {
  const today = pacificToday();

  const { rows } = await db.query(`
    SELECT *
    FROM leads
    WHERE external_ref IS NOT NULL
      AND follow_up_date IS NOT NULL
    ORDER BY external_ref
  `);

  const eligible = rows.filter(row =>
    validFutureDate(row.follow_up_date, today)
  );

  let created = 0;
  let updated = 0;
  let skipped = rows.length - eligible.length;
  let failed = 0;

  console.log(`[backfill] today=${today}`);
  console.log(`[backfill] source=${rows.length} eligible=${eligible.length} skipped=${skipped}`);
  console.log('[backfill] Railway/Postgres only; NO email sends; NO reminder_claims');

  for (const row of eligible) {
    try {
      const result = await upsertLead(db, {
        id: String(row.external_ref),

        lead_first_name: row.first_name || row.lead_first_name || row.name || row.full_name || row.customer_name || String(row.email || row.phone || row.external_ref),
        last_name: row.last_name || null,
        email: row.email || null,
        phone: row.phone || null,

        property_address: row.property_address || row.address || null,
        city: row.city || null,
        project_type: row.project_type || null,

        follow_up_date: row.follow_up_date || null,
        follow_up_time: row.follow_up_time || null,
        follow_up_type: row.follow_up_type || null,

        assigned_rep: row.assigned_rep || null,
        assigned_rep_name: row.assigned_rep_name || row.owner_name || null,
        assigned_rep_email: row.assigned_rep_email || row.owner_email || null,
        assigned_rep_phone: row.assigned_rep_phone || row.owner_phone || null,

        budget_range: row.budget_range || null,
        notes: row.notes || null,
        customer_reminders_disabled: Boolean(row.customer_reminders_disabled),
        crm_created_date: row.created_at || row.crm_created_date || null
      });

      if (result?.action === 'created') created++;
      else updated++;

    } catch (err) {
      failed++;
      console.error(
        `[backfill] FAILED ${row.external_ref}: ${err.message || err}`
      );
    }
  }

  console.log(
    `[backfill] DONE eligible=${eligible.length} created=${created} updated=${updated} skipped=${skipped} failed=${failed}`
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
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
