/* eslint-disable no-undef */
/**
 * notificationPreferences — generic, per-user notification category
 * opt-out, safe for every company (CRM STABILITY PHASE, Section H).
 *
 * Before this module existed, every staff-facing notification
 * (new lead, appointment, follow-up, reminder, contract signed, system
 * failure, etc.) went unconditionally to EVERY address in
 * company_settings.notification_recipients
 * (lib/notificationRecipients.js#getAllStaffRecipients) — one flat list
 * shared by every category, with no way to give one staff member a
 * narrower subset (e.g. "New Lead notifications only") without also
 * removing another category from everyone else.
 *
 * This module layers a per-(user_email, category) enabled/disabled flag
 * on top of that same recipient list. It never invents recipients: a user
 * must already be in notification_recipients (or be the default owner of
 * the specific lead/deal a notification is about) to receive anything —
 * this only lets an admin NARROW what a configured recipient receives.
 *
 * BACKWARD COMPATIBLE BY DESIGN: a (user_email, category) pair with no row
 * in notification_preferences is ENABLED. A fresh installation, or an
 * existing one that has never touched this feature, keeps its exact
 * current behavior (every configured recipient gets every category) until
 * an admin explicitly opts someone out — this migration/feature can never
 * silently go quiet for anyone.
 *
 * CATEGORIES is deliberately generic — no company-specific category or
 * default exists here. (EC's own desired steady-state — e.g. one staff
 * member narrowed to NEW_LEAD only — is configured by an admin through
 * POST /api/v1/notification-preferences, never hardcoded in this file.)
 */
'use strict';

const { query } = require('../db/client');

// Canonical notification categories this installation can independently
// enable/disable per user. Extend this list, never invent a parallel one —
// every call site below (and any future one) should import CATEGORIES
// rather than re-declare its own category string.
const CATEGORIES = Object.freeze({
  NEW_LEAD: 'new_lead',
  APPOINTMENT: 'appointment',
  FOLLOW_UP: 'follow_up',
  REMINDER: 'reminder',
  OVERDUE: 'overdue',
  ESTIMATE: 'estimate',
  INVOICE_PAYMENT: 'invoice_payment',
  CONTRACT_SIGNED: 'contract_signed',
  SOLD: 'sold',
  SYSTEM_FAILURE: 'system_failure',
});

const CATEGORY_VALUES = new Set(Object.values(CATEGORIES));

/**
 * Filter a candidate recipient list down to those who have NOT explicitly
 * disabled this category. Never adds anyone not already in `candidates` —
 * this is a narrowing filter only, never a recipient source.
 */
async function filterRecipientsForCategory(candidates, category) {
  const list = (candidates || []).filter(Boolean);
  if (list.length === 0) return list;
  if (!CATEGORY_VALUES.has(category)) {
    // Unknown category — fail open (deliver) rather than silently drop a
    // notification over a typo'd category string.
    console.warn(`[notificationPreferences] unknown category "${category}" — delivering to all candidates`);
    return list;
  }
  try {
    const { rows } = await query(
      `SELECT user_email FROM notification_preferences WHERE category = $1 AND enabled = false AND user_email = ANY($2)`,
      [category, list.map((e) => String(e).toLowerCase())]
    );
    const disabled = new Set(rows.map((r) => r.user_email.toLowerCase()));
    return list.filter((e) => !disabled.has(String(e).toLowerCase()));
  } catch (e) {
    // A preferences-read failure must never silently swallow a real
    // notification — fail open (deliver to everyone) and log loudly.
    console.error(`[notificationPreferences] read failed, failing open (delivering to all candidates):`, e.message);
    return list;
  }
}

/** All preference rows for one user (admin UI: "this user's settings"). */
async function getPreferencesForUser(userEmail) {
  const { rows } = await query(
    `SELECT category, enabled FROM notification_preferences WHERE user_email = $1`,
    [String(userEmail).toLowerCase()]
  );
  const overrides = new Map(rows.map((r) => [r.category, r.enabled]));
  return Object.values(CATEGORIES).map((category) => ({
    category,
    enabled: overrides.has(category) ? overrides.get(category) : true,
  }));
}

/** Every preference override in the system, grouped by user (admin UI: full matrix). */
async function listAllPreferences() {
  const { rows } = await query(`SELECT user_email, category, enabled FROM notification_preferences ORDER BY user_email, category`);
  return rows;
}

/** Set (upsert) one user's preference for one category. */
async function setPreference(userEmail, category, enabled) {
  if (!userEmail) throw new Error('userEmail required');
  if (!CATEGORY_VALUES.has(category)) throw new Error(`unknown category: ${category}`);
  await query(
    `INSERT INTO notification_preferences (user_email, category, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_email, category) DO UPDATE SET enabled = $3, updated_at = NOW()`,
    [String(userEmail).toLowerCase(), category, !!enabled]
  );
}

module.exports = {
  CATEGORIES,
  filterRecipientsForCategory,
  getPreferencesForUser,
  listAllPreferences,
  setPreference,
};
