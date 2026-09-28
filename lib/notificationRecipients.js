/* eslint-disable no-undef */
/**
 * notificationRecipients — single resolution point for WHO an operational/
 * staff-facing CRM notification goes to and WHO a lead/call routes to when
 * it has no explicit owner (PRODUCTIZATION PHASE 2).
 *
 * Before this module existed, ~10 files (lib/crmActivityNotifier.js,
 * lib/reminderEngine.js, lib/reminderNotifications.js,
 * lib/phoneCallReminders.js, lib/booking/calendarOutbox.js,
 * routes/cronJobs.js, routes/emails.js, routes/signnowWebhook.js,
 * lib/captureAlerts.js, lib/metaLeadMapper.js) each hardcoded
 * michelle@ecconstructiongroup.com / yaron@ecconstructiongroup.com as a
 * literal. A second company's installation would have silently emailed
 * EC's real people on every lead update, reminder, and failure alert.
 *
 * Backed by company_settings.notification_recipients /
 * .default_owner_email / .default_owner_name / .email_from_name (see
 * db/migrations/2026-47-notification-config.sql). EC's existing row is
 * backfilled to its exact historical values by that migration; a fresh
 * installation's scripts/install/bootstrap.js writes neutral values derived
 * from that installation's own admin — never an EC address.
 */
'use strict';

const companyConfig = require('./companyConfig');

/** { to: [...], cc: [...] } — never includes an address this installation
 * did not configure. Falls back to admin_email as "to" only when
 * notification_recipients itself is empty (a database with no explicit
 * routing configured yet, but a bootstrapped admin). */
async function getRecipients() {
  const cfg = await companyConfig.getCompanyConfig();
  const r = cfg.notification_recipients || { to: [], cc: [] };
  const to = Array.isArray(r.to) && r.to.length ? r.to.filter(Boolean) : (cfg.admin_email ? [cfg.admin_email] : []);
  const cc = Array.isArray(r.cc) ? r.cc.filter(Boolean) : [];
  return { to, cc };
}

/** Every configured staff recipient, deduplicated — replaces the old
 * unconditional `[MICHELLE_EMAIL, YARON_EMAIL]` cc lists. */
async function getAllStaffRecipients() {
  const { to, cc } = await getRecipients();
  return Array.from(new Set([...to, ...cc].filter(Boolean)));
}

/** A single fallback staff address — replaces `|| MICHELLE_EMAIL` /
 * `|| YARON_EMAIL` used as "no owner assigned, notify someone" fallbacks. */
async function getPrimaryRecipient() {
  const { to } = await getRecipients();
  return to[0] || null;
}

/** Who a lead/call/deal routes to when it has no explicit assigned rep.
 * Replaces the hardcoded owner_email/assigned_rep fallbacks in
 * lib/metaLeadMapper.js, routes/metaWebhook.js, routes/leads.js. */
async function getDefaultOwner() {
  const cfg = await companyConfig.getCompanyConfig();
  return {
    email: cfg.default_owner_email || cfg.admin_email || null,
    name: cfg.default_owner_name || cfg.admin_name || null,
  };
}

/** Outbound "From" display name — replaces the hardcoded
 * 'EC Construction Group' / 'EC Construction CRM' literals. */
async function getSenderName() {
  const cfg = await companyConfig.getCompanyConfig();
  return cfg.email_from_name || (cfg.company_name ? `${cfg.company_name} CRM` : 'CRM');
}

/** Outbound "From" address. GMAIL_FROM_ADDRESS (the connected Gmail
 * mailbox's env var — see lib/emailService.js) always wins when set, since
 * that's this installation's actual authorized sending account; falls back
 * to the configured admin email, never to a hardcoded EC literal. */
async function getSenderAddress() {
  if (process.env.GMAIL_FROM_ADDRESS) return process.env.GMAIL_FROM_ADDRESS;
  const cfg = await companyConfig.getCompanyConfig();
  return cfg.admin_email || null;
}

/** Emails of admins this installation has explicitly protected from
 * deletion via the Users API — see routes/users.js. Empty by default for a
 * fresh installation (the generic "cannot delete the last admin" rule
 * still applies to everyone). */
async function getProtectedAdminEmails() {
  const cfg = await companyConfig.getCompanyConfig();
  return new Set((cfg.protected_admin_emails || []).map((e) => String(e).toLowerCase()));
}

module.exports = {
  getRecipients,
  getAllStaffRecipients,
  getPrimaryRecipient,
  getDefaultOwner,
  getSenderName,
  getSenderAddress,
  getProtectedAdminEmails,
};
