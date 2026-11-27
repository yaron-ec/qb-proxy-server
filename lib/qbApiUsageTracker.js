/* eslint-disable no-undef */
'use strict';

/**
 * qbApiUsageTracker — a durable, cross-process-safe counter of every REAL
 * outbound HTTP request this backend sends to Intuit's API, built for the
 * November 2026 "QuickBooks API quota management and long-term
 * scalability" CRM reliability request, following the confirmed monthly
 * CorePlus quota exhaustion incident (PR #81).
 *
 * IMPORTANT — what this is and is not:
 *   - This is LOCALLY MEASURED consumption: one increment per real
 *     `fetch()` attempt this codebase actually makes to Intuit (including
 *     each per-call 429/5xx retry — every one of those is a genuine
 *     network round trip that counts against the real quota). It does NOT
 *     increment on a circuit-breaker-open skip (zero network traffic, so
 *     it correctly consumes nothing).
 *   - This is NEVER a substitute for Intuit's own authoritative usage
 *     figure. Intuit exposes a real API-usage chart (categorized Core vs.
 *     CorePlus) ONLY via the Developer Portal UI — Workspace > the app >
 *     Production environment — visible only to that Workspace's Owners/
 *     Admins, with NO programmatic API this codebase could poll to
 *     cross-check itself (confirmed via Intuit's own documentation during
 *     this audit; see CLAUDE.md's "QuickBooks API quota management" section
 *     for the full citation and caveats). Every value this module reports
 *     is explicitly labeled "locally measured" for exactly this reason —
 *     it could legitimately drift from Intuit's real count (a request that
 *     times out client-side before Intuit responds still consumed quota
 *     server-side but may not always be countable here in every edge case;
 *     conversely any call made by another tool/integration against the
 *     same Intuit app, if one ever existed, would never appear here at
 *     all). Treat this as the best available EARLY WARNING signal, not a
 *     bill-of-record.
 *   - The 500,000/month figure is Intuit's own documented CorePlus
 *     App-Partner-Program included limit, scoped to the Developer
 *     WORKSPACE (not per-realm/per-company) — see CLAUDE.md for the
 *     citation. This installation has exactly one Workspace/app/realm
 *     today, so workspace-scoped and effectively "this installation"-
 *     scoped currently coincide; this stops being true the moment a
 *     second company/realm is onboarded under the SAME Intuit Workspace
 *     (see CLAUDE.md's "Multi-company direction" — a second company is a
 *     separate Railway deployment, but if it reuses the same Intuit
 *     Workspace/app registration, the two installations would SHARE this
 *     one 500K/month budget, not each get their own).
 *
 * Thresholds (70/85/95% of 500,000) fire an email, at most once per
 * threshold per calendar month, through the EXISTING staff SYSTEM_FAILURE
 * broadcast category (lib/notificationPreferences.js) — the same
 * mechanism lib/monitoring/alertDispatcher.js and
 * lib/estimateFollowupAlerts.js already use, so Michelle's single-category
 * policy excludes her automatically and no new notification mechanism is
 * introduced.
 */

const db = require('../db/client');

const MONTHLY_QUOTA = 500000;
const THRESHOLDS = [
  { pct: 0.70, column: 'threshold_70_alerted_at', label: '70%' },
  { pct: 0.85, column: 'threshold_85_alerted_at', label: '85%' },
  { pct: 0.95, column: 'threshold_95_alerted_at', label: '95%' },
];

// November 2026 follow-up ("QB API consumption root-cause investigation"):
// official Intuit Developer Portal data (500,766 CorePlus calls/30 days)
// confirmed the one aggregate monthly counter above gave no way to see
// WHICH entity/subsystem was driving usage. NON_ESSENTIAL_THRESHOLD_PCT
// gates the deferrable daily full-reconciliation safety net (see
// lib/qbInboundSync.js#syncAllMappedCustomers's caller in server.js) —
// never the incremental CDC-based invoice/payment sync, which is both the
// cheapest and the most essential path and is never throttled by this.
const NON_ESSENTIAL_THRESHOLD_PCT = 0.90;

function currentMonthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentDateKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function daysInMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * classifyQbCallUrl — pure, best-effort classification of a real QuickBooks
 * request URL into { entity, subsystem }, used ONLY for usage attribution
 * (never for auth, routing, or any behavior change). Never throws — an
 * unrecognized shape reports 'unknown'/'unknown' rather than being silently
 * dropped from the count, so a future new call shape is still visible in
 * the breakdown (just unlabeled) instead of invisible.
 */
function classifyQbCallUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    if (path.endsWith('/cdc')) {
      const entities = (u.searchParams.get('entities') || '').split(',').map((s) => s.trim()).filter(Boolean);
      return { entity: entities.length ? entities.join('+') : 'unknown', subsystem: 'cdc' };
    }
    if (path.endsWith('/query')) {
      const rawQuery = u.searchParams.get('query') || '';
      let q = rawQuery;
      try { q = decodeURIComponent(rawQuery); } catch (e) { /* already decoded or malformed — use raw */ }
      const m = q.match(/FROM\s+(\w+)/i);
      return { entity: m ? m[1] : 'unknown', subsystem: 'query' };
    }
    if (path.includes('/batch')) return { entity: 'Batch', subsystem: 'batch' };
    const m = path.match(/\/(customer|invoice|payment|estimate|companyinfo)\/?/i);
    if (m) {
      const raw = m[1].toLowerCase();
      const entity = raw === 'companyinfo' ? 'CompanyInfo' : raw.charAt(0).toUpperCase() + raw.slice(1);
      return { entity, subsystem: 'direct_get' };
    }
    return { entity: 'unknown', subsystem: 'unknown' };
  } catch (e) {
    return { entity: 'unknown', subsystem: 'unknown' };
  }
}

// Dependency-injection seam for tests — mirrors the convention already
// established by lib/qbRateLimitBreaker.js / lib/qbTokenManager.js's own
// `deps` object.
const DEFAULT_DEPS = {
  query: (...args) => db.query(...args),
  sendThresholdAlert: async (monthKey, count, pct, label) => {
    const notificationRecipients = require('./notificationRecipients');
    const notificationPreferences = require('./notificationPreferences');
    const emailService = require('./emailService');
    const staff = await notificationRecipients.getAllStaffRecipients();
    const recipients = await notificationPreferences.filterRecipientsForCategory(
      staff,
      notificationPreferences.CATEGORIES.SYSTEM_FAILURE
    );
    if (!recipients.length) return { sent: false, reason: 'no_recipients' };
    const pctActual = Math.round((count / MONTHLY_QUOTA) * 1000) / 10;
    const subject = `[EC CRM] QuickBooks API usage at ${label} of monthly quota (${monthKey})`;
    const htmlBody = `
      <p>QuickBooks (Intuit CorePlus) API usage for <strong>${monthKey}</strong> has reached the <strong>${label}</strong> early-warning threshold.</p>
      <table>
        <tr><td style="padding:2px 8px;font-weight:bold;">Locally measured calls this month</td><td style="padding:2px 8px;">${count.toLocaleString('en-US')}</td></tr>
        <tr><td style="padding:2px 8px;font-weight:bold;">Monthly quota (Intuit's own documented limit)</td><td style="padding:2px 8px;">${MONTHLY_QUOTA.toLocaleString('en-US')}</td></tr>
        <tr><td style="padding:2px 8px;font-weight:bold;">Estimated usage</td><td style="padding:2px 8px;">${pctActual}%</td></tr>
      </table>
      <p style="color:#666;font-size:13px;">This figure is <strong>locally measured</strong> by the CRM backend — not Intuit's own confirmed usage. Check the authoritative number in the Intuit Developer Portal (Workspace &rarr; your app &rarr; Production &rarr; API usage chart) before taking action. If the quota is genuinely close to exhaustion, QuickBooks sync will start failing with HTTP 429 "monthly limit" errors until Intuit's next calendar-month reset — reducing non-essential sync frequency now (see System Health's QuickBooks card) can help avoid that.</p>
    `;
    await emailService.send({
      to: recipients,
      subject,
      htmlBody,
      idempotencyKey: `qb-usage-threshold:${monthKey}:${label}`,
    });
    return { sent: true, recipients: recipients.length };
  },
};

let deps = { ...DEFAULT_DEPS };

function _setDeps(overrides) {
  deps = { ...deps, ...overrides };
}
function _resetDeps() {
  deps = { ...DEFAULT_DEPS };
}

/**
 * Records one real outbound HTTP request to Intuit's API. Best-effort and
 * fail-open by design: a tracking bug must never block or slow down a real
 * QuickBooks call. Call this ONLY for an attempt that actually reached the
 * network (never for a circuit-breaker-open synthetic skip).
 *
 * `url` (optional, November 2026 follow-up) — the real request URL, used
 * ONLY to classify this call's entity/subsystem (see classifyQbCallUrl)
 * into the additive `qb_api_usage_by_entity_daily` breakdown table. Never
 * required — a caller that omits it still gets the original monthly total
 * recorded exactly as before; only the breakdown row is skipped.
 */
async function recordApiCall(now = new Date(), url = null) {
  try {
    const monthKey = currentMonthKey(now);
    const nowIso = now.toISOString();
    const result = await deps.query(
      `INSERT INTO qb_api_usage_monthly (month_key, call_count, first_call_at, last_call_at)
       VALUES ($1, 1, $2, $2)
       ON CONFLICT (month_key) DO UPDATE
         SET call_count = qb_api_usage_monthly.call_count + 1, last_call_at = $2
       RETURNING call_count,
         threshold_70_alerted_at, threshold_85_alerted_at, threshold_95_alerted_at`,
      [monthKey, nowIso]
    );
    const row = result.rows[0];
    if (row) await maybeAlertThresholds(monthKey, Number(row.call_count), row);
  } catch (e) {
    console.warn('[qb-usage-tracker] recordApiCall failed (non-fatal): ' + e.message);
  }

  if (!url) return;
  try {
    const { entity, subsystem } = classifyQbCallUrl(url);
    const dateKey = currentDateKey(now);
    await deps.query(
      `INSERT INTO qb_api_usage_by_entity_daily (call_date, entity, subsystem, call_count, updated_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (call_date, entity, subsystem) DO UPDATE
         SET call_count = qb_api_usage_by_entity_daily.call_count + 1, updated_at = now()`,
      [dateKey, entity, subsystem]
    );
  } catch (e) {
    console.warn('[qb-usage-tracker] recordApiCall entity breakdown failed (non-fatal): ' + e.message);
  }
}

async function maybeAlertThresholds(monthKey, callCount, row) {
  for (const t of THRESHOLDS) {
    const alreadyAlerted = row[t.column];
    if (alreadyAlerted) continue;
    if (callCount < MONTHLY_QUOTA * t.pct) continue;
    // Atomically claim this threshold (only the first caller to win the
    // conditional UPDATE sends the alert — a concurrent second request
    // crossing the same threshold in the same instant never double-sends).
    const claim = await deps.query(
      `UPDATE qb_api_usage_monthly SET ${t.column} = now()
       WHERE month_key = $1 AND ${t.column} IS NULL
       RETURNING ${t.column}`,
      [monthKey]
    );
    if (!claim.rows[0]) continue; // another process already claimed it
    try {
      await deps.sendThresholdAlert(monthKey, callCount, t.pct, t.label);
    } catch (e) {
      console.warn(`[qb-usage-tracker] threshold alert send failed for ${t.label} (non-fatal): ` + e.message);
    }
  }
}

/**
 * Read-only snapshot for System Health / admin reporting. Never throws —
 * reports { available: false } on a query failure rather than fabricating
 * a zero (matches this codebase's established "never present an unverified
 * zero as fact" convention).
 */
async function getUsageSnapshot(now = new Date()) {
  try {
    const monthKey = currentMonthKey(now);
    const result = await deps.query(
      `SELECT call_count, first_call_at, last_call_at,
         threshold_70_alerted_at, threshold_85_alerted_at, threshold_95_alerted_at
       FROM qb_api_usage_monthly WHERE month_key = $1`,
      [monthKey]
    );
    const row = result.rows[0];
    const callCount = row ? Number(row.call_count) : 0;
    // Projected end-of-month total (November 2026 follow-up): a simple,
    // transparent linear extrapolation — this month's calls so far, divided
    // by how much of the month has elapsed, scaled to the full month. Never
    // claims precision it doesn't have (an early-month projection off a
    // handful of days is noisy by nature) — `projection_basis_days` is
    // always reported alongside it so a reader can judge confidence.
    const elapsedDays = Math.max(1, now.getUTCDate());
    const totalDays = daysInMonth(now);
    const projectedEndOfMonth = Math.round((callCount / elapsedDays) * totalDays);
    return {
      available: true,
      month_key: monthKey,
      locally_measured_calls: callCount,
      monthly_quota: MONTHLY_QUOTA,
      pct_used: Math.round((callCount / MONTHLY_QUOTA) * 1000) / 10,
      projected_end_of_month_calls: projectedEndOfMonth,
      projected_pct_of_quota: Math.round((projectedEndOfMonth / MONTHLY_QUOTA) * 1000) / 10,
      projection_basis_days: elapsedDays,
      days_in_month: totalDays,
      first_call_at: row?.first_call_at || null,
      last_call_at: row?.last_call_at || null,
      thresholds_alerted: {
        '70pct': !!row?.threshold_70_alerted_at,
        '85pct': !!row?.threshold_85_alerted_at,
        '95pct': !!row?.threshold_95_alerted_at,
      },
      measurement_note:
        'Locally measured by this CRM backend — not confirmed against Intuit\'s own usage figure. ' +
        'Intuit only exposes real usage via the Developer Portal UI (no API this codebase can poll).',
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Read-only per-entity/per-subsystem breakdown for the current calendar
 * month, plus today's own total — answers "WHICH entity/subsystem is
 * driving usage", the exact gap the single aggregate monthly counter above
 * could never show. Never throws; reports { available: false } on a query
 * failure rather than a fabricated empty breakdown.
 */
async function getUsageBreakdown(now = new Date()) {
  try {
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const dateKey = currentDateKey(now);
    const [monthRows, todayRows] = await Promise.all([
      deps.query(
        `SELECT entity, subsystem, SUM(call_count)::bigint AS call_count
         FROM qb_api_usage_by_entity_daily WHERE call_date >= $1::date
         GROUP BY entity, subsystem ORDER BY call_count DESC`,
        [monthStart]
      ),
      deps.query(
        `SELECT entity, subsystem, call_count FROM qb_api_usage_by_entity_daily
         WHERE call_date = $1::date ORDER BY call_count DESC`,
        [dateKey]
      ),
    ]);
    const toRows = (r) => r.rows.map((row) => ({ entity: row.entity, subsystem: row.subsystem, call_count: Number(row.call_count) }));
    const monthBreakdown = toRows(monthRows);
    const totalThisMonth = monthBreakdown.reduce((s, r) => s + r.call_count, 0);
    return {
      available: true,
      month_key: currentMonthKey(now),
      date_key: dateKey,
      this_month_by_entity: monthBreakdown,
      today_by_entity: toRows(todayRows),
      total_this_month_classified: totalThisMonth,
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * isNonEssentialSyncAllowed — automatic protection against excessive
 * consumption (November 2026 follow-up, item 3 of the QB API consumption
 * request): once this month's LOCALLY MEASURED usage crosses
 * NON_ESSENTIAL_THRESHOLD_PCT (90%) of the quota, this reports false so a
 * caller can skip a DEFERRABLE, non-essential sync pass.
 *
 * Deliberately gates ONLY the daily full per-customer reconciliation safety
 * net (lib/qbInboundSync.js#syncAllMappedCustomers, called once/day — see
 * server.js's full-reconcile cron) — NEVER the incremental, CDC-based
 * invoice/payment sync (lib/qbInboundSync.js#syncInvoicesPaymentsIncremental),
 * which is both the cheapest call shape and the one carrying real,
 * time-sensitive financial data; per the explicit requirement to prioritize
 * critical financial synchronization, that path is never throttled by this
 * or any other mechanism. Fails OPEN (returns true — never blocks a sync)
 * on its own query failure, matching this module's established
 * fail-open-on-tracking-bug philosophy.
 */
async function isNonEssentialSyncAllowed(now = new Date()) {
  try {
    const snapshot = await getUsageSnapshot(now);
    if (!snapshot.available) return true;
    return snapshot.pct_used < NON_ESSENTIAL_THRESHOLD_PCT * 100;
  } catch (e) {
    return true;
  }
}

module.exports = {
  MONTHLY_QUOTA,
  THRESHOLDS,
  NON_ESSENTIAL_THRESHOLD_PCT,
  currentMonthKey,
  currentDateKey,
  classifyQbCallUrl,
  recordApiCall,
  getUsageSnapshot,
  getUsageBreakdown,
  isNonEssentialSyncAllowed,
  _setDeps,
  _resetDeps,
};
