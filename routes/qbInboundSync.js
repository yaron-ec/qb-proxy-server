/* eslint-disable no-undef */
'use strict';
const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { syncCustomerFinancials, syncAllMappedCustomers, discoverAndLinkUnmappedCustomers, runFullHistoricalBackfill } = require('../lib/qbInboundSync');

const router = express.Router();

router.post('/sync-customer', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { qb_customer_id } = req.body || {};
    if (!qb_customer_id) return res.status(400).json({ error: 'qb_customer_id is required' });
    const result = await syncCustomerFinancials(String(qb_customer_id));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync-all', async (req, res) => {
  try {
    const workerSecret = process.env.WORKER_SECRET;
    const provided = req.headers['x-worker-secret'] || req.headers['x-proxy-secret'];
    if (!workerSecret || provided !== workerSecret) return res.status(401).json({ error: 'unauthorized' });
    const result = await syncAllMappedCustomers();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/discover', async (req, res) => {
  try {
    const workerSecret = process.env.WORKER_SECRET;
    const provided = req.headers['x-worker-secret'] || req.headers['x-proxy-secret'];
    if (!workerSecret || provided !== workerSecret) return res.status(401).json({ error: 'unauthorized' });
    const result = await discoverAndLinkUnmappedCustomers();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/full-backfill', async (req, res) => {
  try {
    const workerSecret = process.env.WORKER_SECRET;
    const provided = req.headers['x-worker-secret'] || req.headers['x-proxy-secret'];
    if (!workerSecret || provided !== workerSecret) return res.status(401).json({ error: 'unauthorized' });
    const result = await runFullHistoricalBackfill();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
