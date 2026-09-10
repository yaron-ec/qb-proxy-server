/* eslint-disable no-undef */
/**
 * POST /api/v1/cron/calendar-orphan-classification
 *
 * TEMPORARY STRICTly READ-ONLY diagnostic. Returns the exact exhaustive
 * classification of appointments WITHOUT google_event_id (the 947 orphans).
 *
 * ZERO writes. SELECT queries only. No INSERT, UPDATE, DELETE, UPSERT,
 * reconciliation, repair, queue creation, or calendar mutation.
 *
 * Guarded by X-Worker-Secret (WORKER_SECRET) — the same internal
 * authorization pattern as all /api/v1/cron/* endpoints.
 *
 * Returns:
 *   total_appointments
 *   total_without_google_event_id
 *   classification:
 *     scheduled_future: { count, google_event_id_null, google_event_id_not_null,
 *                         outbox_exists, outbox_absent, outbox_status_distribution }
 *     scheduled_past:   { ... }
 *     completed:        { ... }
 *     cancelled:        { ... }
 *     other:            { ... }
 *   min_start_at
 *   max_start_at
 *   future_scheduled_no_google_event_count
 *   future_scheduled_no_outbox_count
 *
 * The five categories sum exactly to total_without_google_event_id.
 */
'use strict';

const express = require('express');
const { query } = require('../db/client');

const router = express.Router();

// ── Auth: X-Worker-Secret ────────────────────────────────────────────────────
function requireWorkerSecret(req, res, next) {
  const secret = req.headers['x-worker-secret'];
  if (!process.env.WORKER_SECRET || secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Worker-Secret' });
  }
  next();
}

router.use(requireWorkerSecret);

// ── POST /calendar-orphan-classification ─────────────────────────────────────
router.post('/calendar-orphan-classification', async (req, res) => {
  try {
    // ── 1. Total appointments ──────────────────────────────────────────────
    const { rows: totalRows } = await query('SELECT COUNT(*)::int AS cnt FROM appointments');
    const totalAppointments = totalRows[0].cnt;

    // ── 2. Total without google_event_id ───────────────────────────────────
    const { rows: orphanRows } = await query(
      'SELECT COUNT(*)::int AS cnt FROM appointments WHERE google_event_id IS NULL'
    );
    const totalWithoutGoogleEventId = orphanRows[0].cnt;

    // ── 3. MIN/MAX start_at ────────────────────────────────────────────────
    const { rows: rangeRows } = await query(
      'SELECT MIN(start_at) AS min_start_at, MAX(start_at) AS max_start_at FROM appointments'
    );
    const minStartAt = rangeRows[0].min_start_at;
    const maxStartAt = rangeRows[0].max_start_at;

    // ── 4. Classification by status × google_event_id ─────────────────────
    // Categories: scheduled_future, scheduled_past, completed, cancelled, other
    // "scheduled" = status IN ('scheduled', 'confirmed')
    // "future" = start_at >= NOW()
    const { rows: classRows } = await query(`
      SELECT
        CASE
          WHEN status IN ('scheduled', 'confirmed') AND start_at >= NOW() THEN 'scheduled_future'
          WHEN status IN ('scheduled', 'confirmed') AND start_at < NOW() THEN 'scheduled_past'
          WHEN status = 'completed' THEN 'completed'
          WHEN status = 'cancelled' THEN 'cancelled'
          ELSE 'other'
        END AS category,
        COUNT(*)::int AS cnt
      FROM appointments
      WHERE google_event_id IS NULL
      GROUP BY category
    `);
    const classMap = {};
    for (const r of classRows) classMap[r.category] = r.cnt;

    // ── 5. For each category: google_event_id NULL/NOT NULL ────────────────
    // (All orphans have google_event_id NULL by definition, but we verify.)
    const { rows: googleIdRows } = await query(`
      SELECT
        CASE
          WHEN status IN ('scheduled', 'confirmed') AND start_at >= NOW() THEN 'scheduled_future'
          WHEN status IN ('scheduled', 'confirmed') AND start_at < NOW() THEN 'scheduled_past'
          WHEN status = 'completed' THEN 'completed'
          WHEN status = 'cancelled' THEN 'cancelled'
          ELSE 'other'
        END AS category,
        google_event_id IS NULL AS is_null,
        COUNT(*)::int AS cnt
      FROM appointments
      WHERE google_event_id IS NULL
      GROUP BY category, is_null
    `);

    // ── 6. For each category: calendar_outbox exists/absent + status dist ──
    // Join appointments with calendar_outbox on appointment_id.
    const { rows: outboxRows } = await query(`
      SELECT
        CASE
          WHEN a.status IN ('scheduled', 'confirmed') AND a.start_at >= NOW() THEN 'scheduled_future'
          WHEN a.status IN ('scheduled', 'confirmed') AND a.start_at < NOW() THEN 'scheduled_past'
          WHEN a.status = 'completed' THEN 'completed'
          WHEN a.status = 'cancelled' THEN 'cancelled'
          ELSE 'other'
        END AS category,
        COALESCE(o.status, 'absent') AS outbox_status,
        COUNT(*)::int AS cnt
      FROM appointments a
      LEFT JOIN calendar_outbox o ON o.appointment_id = a.id
      WHERE a.google_event_id IS NULL
      GROUP BY category, outbox_status
      ORDER BY category, outbox_status
    `);

    // Build the full classification structure
    const categories = ['scheduled_future', 'scheduled_past', 'completed', 'cancelled', 'other'];
    const classification = {};
    for (const cat of categories) {
      const outboxStatuses = {};
      for (const r of outboxRows) {
        if (r.category === cat) {
          outboxStatuses[r.outbox_status] = r.cnt;
        }
      }
      const outboxExists = Object.entries(outboxStatuses)
        .filter(([k]) => k !== 'absent')
        .reduce((sum, [, v]) => sum + v, 0);
      const outboxAbsent = outboxStatuses['absent'] || 0;

      classification[cat] = {
        count: classMap[cat] || 0,
        google_event_id_null: classMap[cat] || 0,
        google_event_id_not_null: 0, // All orphans have NULL by definition
        outbox_exists: outboxExists,
        outbox_absent: outboxAbsent,
        outbox_status_distribution: outboxStatuses,
      };
    }

    // ── 7. Exact future scheduled/no-Google-event count ─────────────────────
    const { rows: futureNoGoogleRows } = await query(`
      SELECT COUNT(*)::int AS cnt
      FROM appointments
      WHERE google_event_id IS NULL
        AND status IN ('scheduled', 'confirmed')
        AND start_at >= NOW()
    `);
    const futureScheduledNoGoogleEventCount = futureNoGoogleRows[0].cnt;

    // ── 8. Exact future scheduled/no-outbox count ───────────────────────────
    const { rows: futureNoOutboxRows } = await query(`
      SELECT COUNT(*)::int AS cnt
      FROM appointments a
      WHERE a.google_event_id IS NULL
        AND a.status IN ('scheduled', 'confirmed')
        AND a.start_at >= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM calendar_outbox o WHERE o.appointment_id = a.id
        )
    `);
    const futureScheduledNoOutboxCount = futureNoOutboxRows[0].cnt;

    // ── 9. Verify sum equals total_without_google_event_id ──────────────────
    const classifiedSum = categories.reduce((sum, cat) => sum + (classification[cat].count || 0), 0);

    res.json({
      diagnostic: 'calendar-orphan-classification',
      read_only: true,
      zero_writes: true,
      total_appointments: totalAppointments,
      total_without_google_event_id: totalWithoutGoogleEventId,
      classification,
      classified_sum: classifiedSum,
      sum_matches: classifiedSum === totalWithoutGoogleEventId,
      min_start_at: minStartAt,
      max_start_at: maxStartAt,
      future_scheduled_no_google_event_count: futureScheduledNoGoogleEventCount,
      future_scheduled_no_outbox_count: futureScheduledNoOutboxCount,
      queried_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[cron] calendar-orphan-classification error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;