/* eslint-disable no-undef */
/**
 * GET /api/v1/leads/:id/reminder-diagnostics — admin-only, read-only
 * appointment-notification diagnostic for a single lead (November 2026).
 *
 * Reuses lib/reminderDeliveryDiagnostics.js#getAppointmentNotificationDiagnostics
 * — the SAME underlying read-only query logic the pre-existing
 * X-Worker-Secret-gated POST /api/v1/cron/diagnose-reminder-delivery uses,
 * never calling that route from the browser and never exposing
 * WORKER_SECRET to the frontend. Auth here is the CRM's own existing
 * admin JWT (lib/rbac.js), exactly like every other admin-only route in
 * this codebase (e.g. routes/systemInfo.js).
 *
 * Purely read-only — issues only SELECT queries, never writes anything.
 */
'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../lib/rbac');
const { getAppointmentNotificationDiagnostics } = require('../lib/reminderDeliveryDiagnostics');

const router = express.Router();

router.get('/leads/:id/reminder-diagnostics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await getAppointmentNotificationDiagnostics(req.params.id);
    res.json(result);
  } catch (e) {
    console.error('[reminder-diagnostics] error:', e.message);
    res.status(500).json({ error: 'reminder_diagnostics_failed', message: e.message });
  }
});

module.exports = router;
