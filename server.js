
// Manual triggers (guarded by X-Proxy-Secret, same as all /qb/* routes)
app.post('/sync/qb-estimates', requireProxySecret, async (req, res) => {
  try {
    const result = await runQbEstimateSync();
    return res.json(result);
  } catch (e) {
    if (e.reconnectRequired) return handleQBError(e, res);
    console.error('[qb-sync] fatal:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/sync/qb-estimate-pdfs', requireProxySecret, async (req, res) => {
  try {
    const result = await runQbEstimatePdfSync();
    return res.json(result);
  } catch (e) {
    if (e.reconnectRequired) return handleQBError(e, res);
    console.error('[qb-pdf] fatal:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[proxy] QuickBooks Proxy running on port ${PORT}`);
  console.log(`[proxy] Environment: ${QB_ENVIRONMENT}`);
  console.log(`[proxy] API Base: ${QB_API_BASE}`);

  // ── QB Estimate Sync Cron ─────────────────────────────────────────────────
  // Off by default. Set QB_SYNC_CRON_ENABLED=true on Railway to start the 15-min
  // loop (estimates sync + PDF fetch). Keeps the Base44 scheduler as fallback until
  // parity is verified, then disable the Base44 automation and leave this running.
  let cronLib = null;
  try { cronLib = require('node-cron'); } catch (e) {
    console.warn('[proxy] node-cron not installed - QB sync cron disabled (npm install will add it)');
  }
  if (cronLib) {
    if (process.env.QB_SYNC_CRON_ENABLED !== 'true') {
      console.log('[proxy] QB sync cron disabled (set QB_SYNC_CRON_ENABLED=true to enable every-15-min sync)');
    } else {
      cronLib.schedule('*/15 * * * *', async () => {
        const t = new Date().toISOString();
        console.log(`[qb-cron] tick ${t}`);
        try {
          const r = await runQbEstimateSync();
          console.log(`[qb-cron] sync ok - matched ${r.stats?.matched} imported ${r.stats?.imported} updated ${r.stats?.updated}`);
        } catch (e) {
          console.error('[qb-cron] sync failed:', e.message);
        }
        try {
          await runQbEstimatePdfSync();
        } catch (e) {
          console.error('[qb-cron] pdf sync failed:', e.message);
        }
      });
      console.log('[proxy] QB sync cron scheduled every 15 minutes (QB_SYNC_CRON_ENABLED=true)');
    }
  }
});