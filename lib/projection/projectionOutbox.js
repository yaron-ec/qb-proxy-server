/* eslint-disable no-undef */
/**
 * projectionOutbox — worker-side projection outbox drainer.
 *
 * Current-state Lead-aggregate projection. The worker:
 *   1. claims a batch of pending/failed rows (FOR UPDATE SKIP LOCKED)
 *   2. for each row: reads the CURRENT Railway aggregate (lead + active appt)
 *   3. applies the revision guard (< / == / >)
 *   4. if project: reconciles + writes to Base44 via base44ProjectionClient
 *   5. upserts base44_entity_map with the new revision
 *   6. finalizes the row synced
 *
 * Out-of-order safe: a row whose revision is <= the last projected revision is
 * finalized as synced without calling Base44 (stale / already-projected skip).
 *
 * `base44` is injected so tests can mock it; the worker passes the real
 * lib/base44.js module.
 */
'use strict';

const { reconcileAndWrite, buildCreatePayload, buildUpdatePayload, laParts } = require('./base44ProjectionClient');

const DEFAULT_LEASE_SEC = 60;
const DEFAULT_BATCH = 25;

// ── Pure helpers (exported for direct testing) ──────────────────────────────

/**
 * Deterministic active-appointment selection.
 * Active = status IN ('scheduled','confirmed'). If >1, project the earliest
 * start_at (deterministic) and flag multiple for diagnostics. Never arbitrary.
 * @param {array} appts - active appointments, ordered by start_at ASC
 * @returns {{appointment:object|null, multiple:boolean, count:number}}
 */
function selectActiveAppointment(appts) {
  const list = Array.isArray(appts) ? appts : [];
  if (list.length === 0) return { appointment: null, multiple: false, count: 0 };
  // caller is expected to pass ASC-ordered; sort defensively anyway
  const sorted = [...list].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  return { appointment: sorted[0], multiple: sorted.length > 1, count: sorted.length };
}

/**
 * Revision guard.
 * @returns {'stale'|'already'|'project'}
 */
function compareRevision(rowRevision, mapRevision) {
  const m = mapRevision || 0;
  if (rowRevision < m) return 'stale';
  if (rowRevision === m) return 'already';
  return 'project';
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function claimNext(pool, workerId, limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, lead_id, revision, action, attempts, max_attempts
       FROM projection_outbox
       WHERE status IN ('pending','failed')
         AND next_attempt_at <= NOW()
         AND attempts < max_attempts
       ORDER BY revision ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      await client.query(
        `UPDATE projection_outbox
           SET status='processing', attempts=attempts+1, claimed_by=$1,
               claimed_at=NOW(), updated_at=NOW()
         WHERE id = ANY($2)`,
        [workerId, ids]
      );
      // reflect the incremented attempt count on the returned rows
      rows.forEach((r) => { r.attempts = r.attempts + 1; });
    }
    await client.query('COMMIT');
    return rows;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

async function finalizeSynced(pool, id) {
  await pool.query(
    `UPDATE projection_outbox
       SET status='synced', last_error=NULL, claimed_by=NULL, claimed_at=NULL,
           updated_at=NOW()
     WHERE id = $1`,
    [id]
  );
}

async function markFailed(pool, row, err) {
  const isRateLimit = err && (err.code === 'BASE44_RATE_LIMIT' || /rate|429|quota/i.test(err.message || ''));
  const isDuplicate = err && err.code === 'DUPLICATE_RAILWAY_LEAD_ID';
  const attempts = row.attempts; // already incremented at claim time
  const maxAttempts = row.max_attempts || 5;
  const dead = attempts >= maxAttempts;
  const baseSec = isRateLimit ? 300 : 30;
  const capSec = isRateLimit ? 7200 : 1800;
  const backoffSec = isDuplicate
    ? Math.min(300 * attempts, 1800) // duplicate: short bounded retry for manual resolution
    : Math.min(Math.pow(2, Math.max(attempts - 1, 0)) * baseSec, capSec);
  await pool.query(
    `UPDATE projection_outbox
       SET status=$1, last_error=$2,
           next_attempt_at=NOW() + ($3 || ' seconds')::interval,
           updated_at=NOW()
     WHERE id = $4`,
    [dead ? 'dead' : 'failed', String(err && err.message || 'unknown').slice(0, 500), backoffSec, row.id]
  );
}

async function reapStuck(pool, leaseSec) {
  const lease = leaseSec || DEFAULT_LEASE_SEC;
  const { rowCount } = await pool.query(
    `UPDATE projection_outbox
       SET status='pending', claimed_by=NULL, claimed_at=NULL, updated_at=NOW()
     WHERE status='processing'
       AND claimed_at < NOW() - ($1 || ' seconds')::interval`,
    [String(lease)]
  );
  return rowCount || 0;
}

async function readCurrentAggregate(pool, leadId) {
  const leadRes = await pool.query(
    `SELECT l.*, o.display_name AS owner_display_name
       FROM leads l
       LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.id = $1`,
    [leadId]
  );
  if (!leadRes.rows[0]) return null;
  const apptRes = await pool.query(
    `SELECT id, start_at, end_at, status, appointment_type_id
       FROM appointments
      WHERE lead_id = $1 AND status IN ('scheduled','confirmed')
      ORDER BY start_at ASC`,
    [leadId]
  );
  return { lead: leadRes.rows[0], activeAppointments: apptRes.rows };
}

// ── Row processing ──────────────────────────────────────────────────────────

/**
 * Process one outbox row.
 * @param {object} deps - { pool, base44 }
 * @param {object} row - claimed outbox row
 */
async function processRow(deps, row) {
  const { pool, base44 } = deps;

  const agg = await readCurrentAggregate(pool, row.lead_id);
  if (!agg) {
    // Lead gone — finalize as synced (nothing to project). Defensive.
    await finalizeSynced(pool, row.id);
    return { skipped: 'lead_gone' };
  }

  const mapRes = await pool.query(
    'SELECT * FROM base44_entity_map WHERE railway_lead_id = $1',
    [row.lead_id]
  );
  const mapRow = mapRes.rows[0] || null;

  const cmp = compareRevision(row.revision, mapRow ? mapRow.railway_revision : 0);
  if (cmp !== 'project') {
    // stale (row.revision < map.revision) OR already (row.revision == map.revision)
    await finalizeSynced(pool, row.id);
    return { skipped: cmp };
  }

  const { appointment, multiple, count } = selectActiveAppointment(agg.activeAppointments);
  if (multiple) {
    console.warn(`[projectionOutbox] multiple_active_appointments: lead=${row.lead_id} count=${count} projected=${appointment.id}`);
  }
  const projectionAggregate = {
    lead: agg.lead,
    ownerDisplayName: agg.lead.owner_display_name,
    appointment,
  };

  const result = await reconcileAndWrite(base44, projectionAggregate, mapRow);

  // upsert the map with the new revision (GREATEST semantics via the guard)
  await pool.query(
    `INSERT INTO base44_entity_map (railway_lead_id, base44_id, railway_revision, last_synced_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (railway_lead_id) DO UPDATE
       SET base44_id = EXCLUDED.base44_id,
           railway_revision = EXCLUDED.railway_revision,
           last_synced_at = NOW()`,
    [row.lead_id, result.base44Id, row.revision]
  );

  await finalizeSynced(pool, row.id);
  return { projected: true, mode: result.mode, base44Id: result.base44Id };
}

/**
 * Claim + process a batch. Returns { processed, projected, skipped, failed }.
 */
async function processBatch(deps, workerId, limit) {
  const { pool } = deps;
  const rows = await claimNext(pool, workerId, limit || DEFAULT_BATCH);
  let projected = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    try {
      const r = await processRow(deps, row);
      if (r.projected) projected++;
      else skipped++;
    } catch (err) {
      failed++;
      await markFailed(pool, row, err).catch((e) =>
        console.error(`[projectionOutbox] markFailed error for row ${row.id}:`, e.message)
      );
      console.error(`[projectionOutbox] row ${row.id} failed:`, err.message);
    }
  }
  return { processed: rows.length, projected, skipped, failed };
}

module.exports = {
  processBatch,
  processRow,
  claimNext,
  finalizeSynced,
  markFailed,
  reapStuck,
  readCurrentAggregate,
  selectActiveAppointment,
  compareRevision,
  DEFAULT_LEASE_SEC,
  DEFAULT_BATCH,
};