/* eslint-env node */
/* global require, process, __dirname, __filename, module, exports */
/**
 * Handoff RPA Worker — Railway-hosted Playwright service
 *
 * Required env vars (set in Railway):
 *   HANDOFF_EMAIL       — your Handoff login email
 *   HANDOFF_PASSWORD    — your Handoff login password
 *   HANDOFF_URL         — base URL (default: https://app.handoff.com)
 *   BASE44_IMPORT_URL   — full URL to the handoffBulkImport Base44 function
 *   WORKER_SECRET       — shared secret (must match Base44 WORKER_SECRET)
 *   PORT                — (optional) defaults to 3000
 */

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const HANDOFF_EMAIL = process.env.HANDOFF_EMAIL || '';
const HANDOFF_PASSWORD = process.env.HANDOFF_PASSWORD || '';
const HANDOFF_URL = (process.env.HANDOFF_URL || 'https://app.handoff.com').replace(/\/$/, '');
const BASE44_IMPORT_URL = process.env.BASE44_IMPORT_URL || ''; // legacy — replaced by PROXY_IMPORT_URL
const PROXY_IMPORT_URL = process.env.PROXY_IMPORT_URL || ''; // route imports through QB proxy

const CHECKPOINT_FILE = '/tmp/handoff_worker_checkpoint.json';

let isRunning = false;

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  if (!WORKER_SECRET) return next(); // no secret configured = open (dev mode)
  const provided = req.headers['x-worker-secret'] || '';
  if (provided !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Checkpoint helpers ────────────────────────────────────────────────────────
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    }
  } catch (e) {}
  return { processedIds: [], lastRunAt: null };
}

function saveCheckpoint(data) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[checkpoint] save failed:', e.message);
  }
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
  } catch (e) {}
}

// ─── Import a single estimate to Base44 via QB proxy ─────────────────────────
async function importEstimate(estimateData) {
  if (!PROXY_IMPORT_URL) {
    console.log('[import] PROXY_IMPORT_URL not set, skipping import');
    return { skipped: true, reason: 'no_proxy_import_url' };
  }

  const payload = {
    source: 'rpa_worker',
    estimateId: estimateData.id,
    estimateNumber: estimateData.number || estimateData.id,
    exportType: 'json',
    exportData: JSON.stringify(estimateData),
  };

  const res = await fetch(`${PROXY_IMPORT_URL}/handoff/import-estimate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': PROXY_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Import API returned ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ─── Log run summary to Base44 ─────────────────────────────────────────────────
async function logSummary(summary) {
  // Summary logging: only fire if legacy BASE44_IMPORT_URL is set.
  // Proxy import route doesn't need a separate summary call.
  if (!BASE44_IMPORT_URL) return;
  try {
    await fetch(BASE44_IMPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ source: 'rpa_worker_summary', ...summary }),
    });
  } catch (e) {
    console.error('[summary] failed to log:', e.message);
  }
}

// ─── Main RPA run ──────────────────────────────────────────────────────────────
async function runWorker() {
  console.log('[worker] Starting RPA run at', new Date().toISOString());

  const checkpoint = loadCheckpoint();
  const alreadyProcessed = new Set(checkpoint.processedIds || []);
  console.log(`[worker] Checkpoint: ${alreadyProcessed.size} already processed`);

  const stats = { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
  const runAt = new Date().toISOString();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    });
    const page = await context.newPage();

    // ── Login ──────────────────────────────────────────────────────────────────
    console.log('[worker] Navigating to login...');
    await page.goto(`${HANDOFF_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });

    // Fill email
    await page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', HANDOFF_EMAIL);
    // Fill password
    await page.fill('input[type="password"], input[name="password"], input[placeholder*="password" i]', HANDOFF_PASSWORD);
    // Submit
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")');

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    console.log('[worker] Logged in, current URL:', page.url());

    // Check login succeeded
    if (page.url().includes('/login') || page.url().includes('/signin')) {
      throw new Error('Login failed — still on login page. Check HANDOFF_EMAIL and HANDOFF_PASSWORD.');
    }

    // ── Navigate to estimates ──────────────────────────────────────────────────
    console.log('[worker] Navigating to estimates...');
    await page.goto(`${HANDOFF_URL}/estimates`, { waitUntil: 'networkidle', timeout: 30000 });

    // ── Intercept API responses to capture estimate data ───────────────────────
    // Handoff is a React/SPA — we intercept the API call the page makes for estimates
    const estimates = [];

    // Intercept network requests to capture the estimates list API response
    const estimateApiPattern = /\/api\/(graphql|estimates|projects)/i;

    // Set up response interception
    page.on('response', async (response) => {
      const url = response.url();
      if (!estimateApiPattern.test(url)) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        // GraphQL estimates list
        const gqlEstimates = json?.data?.estimates;
        if (Array.isArray(gqlEstimates)) {
          for (const est of gqlEstimates) {
            if (est?.id && !estimates.find(e => e.id === est.id)) {
              estimates.push(est);
            }
          }
          console.log(`[intercept] Captured ${gqlEstimates.length} estimates from GraphQL`);
        }

        // REST estimates list
        const restEstimates = Array.isArray(json) ? json : json?.estimates || json?.data || json?.items;
        if (Array.isArray(restEstimates) && restEstimates.length > 0 && restEstimates[0]?.id) {
          for (const est of restEstimates) {
            if (est?.id && !estimates.find(e => e.id === est.id)) {
              estimates.push(est);
            }
          }
          console.log(`[intercept] Captured ${restEstimates.length} estimates from REST`);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    // Wait for the estimates page to load and trigger API calls
    await page.waitForTimeout(5000);

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    // Try clicking "Load more" / pagination if present
    let loadMoreClicks = 0;
    while (loadMoreClicks < 20) {
      const loadMoreBtn = await page.$('button:has-text("Load more"), button:has-text("Show more"), button:has-text("Next"), [data-testid="load-more"]');
      if (!loadMoreBtn) break;
      const isVisible = await loadMoreBtn.isVisible();
      if (!isVisible) break;
      console.log(`[worker] Clicking "Load more" (attempt ${loadMoreClicks + 1})`);
      await loadMoreBtn.click();
      await page.waitForTimeout(2000);
      loadMoreClicks++;
    }

    console.log(`[worker] Captured ${estimates.length} estimates total from network interception`);

    // ── Fallback: scrape from DOM if interception found nothing ────────────────
    if (estimates.length === 0) {
      console.log('[worker] Falling back to DOM scrape...');
      const scraped = await page.evaluate(() => {
        const rows = [];
        // Try common estimate row selectors
        const cards = document.querySelectorAll('[data-estimate-id], [data-id], .estimate-row, .estimate-card, tr[data-id]');
        cards.forEach(el => {
          const id = el.dataset.estimateId || el.dataset.id || '';
          const name = el.querySelector('.customer-name, .client-name, .name, [class*="customer"], [class*="client"]')?.textContent?.trim() || '';
          const amount = el.querySelector('.amount, .total, .price, [class*="amount"], [class*="price"]')?.textContent?.trim() || '';
          const status = el.querySelector('.status, .badge, [class*="status"]')?.textContent?.trim() || '';
          if (id || name) rows.push({ id: id || `dom_${Date.now()}_${rows.length}`, customerName: name, amount: parseFloat(amount.replace(/[^0-9.]/g, '')) || 0, status });
        });
        return rows;
      });
      estimates.push(...scraped);
      console.log(`[worker] DOM scrape found ${scraped.length} estimates`);
    }

    await browser.close();
    browser = null;

    // ── Import each estimate ───────────────────────────────────────────────────
    console.log(`[worker] Importing ${estimates.length} estimates...`);

    for (const est of estimates) {
      const estId = String(est.id || '');
      if (!estId) { stats.skipped++; continue; }

      if (alreadyProcessed.has(estId)) {
        stats.skipped++;
        continue;
      }

      try {
        const result = await importEstimate(est);
        if (result.imported) stats.imported++;
        else if (result.updated) stats.updated++;
        else stats.skipped++;

        alreadyProcessed.add(estId);
        // Save checkpoint after each successful import
        saveCheckpoint({ processedIds: [...alreadyProcessed], lastRunAt: runAt });
      } catch (e) {
        console.error(`[worker] Failed to import ${estId}:`, e.message);
        stats.failed++;
        stats.errors.push(`${estId}: ${e.message}`);
      }
    }

    console.log('[worker] Run complete:', JSON.stringify(stats));
    clearCheckpoint(); // clear on full success

    // Log summary to Base44
    await logSummary({ ...stats, run_at: runAt, total: estimates.length });

    return { success: true, ...stats, total: estimates.length };
  } catch (e) {
    console.error('[worker] Fatal error:', e.message);
    if (browser) {
      // Take screenshot on failure
      try {
        const page = (await browser.contexts())?.[0]?.pages()?.[0];
        if (page) {
          await page.screenshot({ path: '/tmp/worker_error.png' });
          console.log('[worker] Screenshot saved to /tmp/worker_error.png');
        }
      } catch (se) {}
      await browser.close().catch(() => {});
    }
    throw e;
  } finally {
    isRunning = false;
  }
}

// ─── Base44 Function Cron Runner ─────────────────────────────────────────────
// Calls Base44 backend functions on a schedule. Functions use asServiceRole and
// accept the x-worker-secret header (WORKER_SECRET) for auth bypass.
//
// Env: BASE44_APP_URL — base URL of the Base44 app hosting the functions
//      (e.g. https://eccrm.base44.app). Defaults to the standard app domain.

const PROXY_SECRET = process.env.PROXY_SECRET || WORKER_SECRET; // kept for importEstimate()
const BASE44_APP_URL = (process.env.BASE44_APP_URL || 'https://eccrm.base44.app').replace(/\/$/, '');

async function callBase44Function(functionName, payload = {}) {
  const url = `${BASE44_APP_URL}/functions/${functionName}`;
  console.log(`[cron] → ${functionName} at ${new Date().toISOString()}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      console.error(`[cron] ✗ ${functionName} returned ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, data };
    }
    console.log(`[cron] ✓ ${functionName} ok (${res.status})`);
    return { ok: true, status: res.status, data };
  } catch (e) {
    console.error(`[cron] ✗ ${functionName} fetch failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Reminder crons — every 30 minutes (appointment reminders + task reminders)
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
setTimeout(() => {
  console.log('[cron] Reminder loop started — firing every 30 minutes');
  Promise.all([
    callBase44Function('sendAppointmentReminder'),
    callBase44Function('sendTaskReminders'),
  ]).catch(e => console.error('[cron] Initial reminder run failed:', e.message));
  setInterval(() => {
    Promise.all([
      callBase44Function('sendAppointmentReminder'),
      callBase44Function('sendTaskReminders'),
    ]).catch(e => console.error('[cron] Reminder run failed:', e.message));
  }, REMINDER_INTERVAL_MS);
}, 60 * 1000);

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', requireSecret, (req, res) => {
  const checkpoint = loadCheckpoint();
  res.json({
    online: true,
    running: isRunning,
    configured: !!(HANDOFF_EMAIL && HANDOFF_PASSWORD && (PROXY_IMPORT_URL || BASE44_IMPORT_URL)),
    checkpoint: checkpoint.lastRunAt ? { lastRunAt: checkpoint.lastRunAt, processedCount: checkpoint.processedIds?.length || 0 } : null,
  });
});

app.post('/run', requireSecret, async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ already_running: true, message: 'Worker is already running' });
  }

  if (!HANDOFF_EMAIL || !HANDOFF_PASSWORD) {
    return res.status(400).json({ error: 'HANDOFF_EMAIL and HANDOFF_PASSWORD must be set in Railway env vars' });
  }

  if (!PROXY_IMPORT_URL && !BASE44_IMPORT_URL) {
    return res.status(400).json({ error: 'PROXY_IMPORT_URL must be set in Railway env vars (base URL of the QB proxy, e.g. https://qb-proxy.railway.app)' });
  }

  // Start async, respond immediately
  isRunning = true;
  res.json({ started: true, message: 'Worker started — check Railway logs for progress' });

  runWorker().catch(e => {
    console.error('[worker] Unhandled error:', e.message);
    isRunning = false;
  });
});

app.post('/reset-checkpoint', requireSecret, (req, res) => {
  clearCheckpoint();
  res.json({ cleared: true });
});

app.get('/', (req, res) => {
  res.json({ service: 'Handoff RPA Worker', status: isRunning ? 'running' : 'idle' });
});

app.listen(PORT, () => {
  const nowIso = new Date().toISOString();
  const nowLA  = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const tzEnv  = process.env.TZ || '(not set)';
  const appTz  = process.env.APP_TIMEZONE || '(not set)';
  console.log(`[server] Handoff RPA worker listening on port ${PORT}`);
  console.log(`[server] Boot time UTC   : ${nowIso}`);
  console.log(`[server] Boot time LA    : ${nowLA}`);
  console.log(`[server] TZ env          : ${tzEnv}`);
  console.log(`[server] APP_TIMEZONE env: ${appTz}`);
  console.log(`[server] HANDOFF_EMAIL: ${HANDOFF_EMAIL ? '✓ set' : '✗ NOT SET'}`);
  console.log(`[server] HANDOFF_PASSWORD: ${HANDOFF_PASSWORD ? '✓ set' : '✗ NOT SET'}`);
  console.log(`[server] PROXY_IMPORT_URL: ${PROXY_IMPORT_URL ? '✓ set' : '✗ NOT SET (set to QB proxy base URL)'}`);
  console.log(`[server] BASE44_IMPORT_URL: ${BASE44_IMPORT_URL ? '✓ set (legacy)' : '✗ not set (ok if PROXY_IMPORT_URL is set)'}`);
  console.log(`[server] WORKER_SECRET: ${WORKER_SECRET ? '✓ set' : '✗ NOT SET (open access)'}`);
});