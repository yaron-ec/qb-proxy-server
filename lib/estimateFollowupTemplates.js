/* eslint-disable no-undef */
/**
 * estimateFollowupTemplates — the six editable, versioned email bodies for
 * the automated 14-day estimate follow-up sequence, plus rendering and the
 * CAN-SPAM compliance footer.
 *
 * Storage: estimate_followup_templates (db/migrations/2026-70-estimate-
 * followup-sequence.sql), seeded with the business owner's own exact given
 * wording at version 1 (not Claude-authored — same "one-time approval
 * record" precedent as lib/smsTemplates.js). Editing a template
 * (saveTemplateVersion) NEVER mutates an existing row — it inserts a new
 * version and flips which one is_active, so the exact wording actually
 * sent to any given customer is always reconstructable from history.
 *
 * Rendering is deliberately NOT wrapped in lib/emailTemplates.js's branded
 * logo/banner shell. These six messages are written in first person as a
 * personal note from the assigned sales rep — a corporate banner would
 * undercut exactly the tone the given wording is going for. Only a small,
 * unobtrusive compliance block (physical mailing address + unsubscribe
 * link, required by CAN-SPAM for this kind of promotional follow-up) is
 * appended at render time, never baked into body_html, so editing the
 * company's address in Company Settings never requires a new template
 * version.
 *
 * The compliance footer's address is read from company_settings via
 * lib/companyConfig.js — NEVER invented. If no address is configured,
 * rendering throws ConfigurationError rather than silently sending a
 * non-compliant email; lib/estimateFollowupEngine.js treats this as a
 * blocking configuration prerequisite, surfaced in the dry-run report and
 * admin overview, not a per-lead failure.
 */
'use strict';

const db = require('../db/client');
const companyConfig = require('./companyConfig');

// Order matters: this is the canonical 6-step cadence every sequence is
// built from. day_offset is calendar days after the verified
// estimate-sent instant, in the installation's configured timezone.
const DEFAULT_SCHEDULE = [
  { stepNumber: 1, dayOffset: 1, templateKey: 'day1' },
  { stepNumber: 2, dayOffset: 3, templateKey: 'day3' },
  { stepNumber: 3, dayOffset: 5, templateKey: 'day5' },
  { stepNumber: 4, dayOffset: 8, templateKey: 'day8' },
  { stepNumber: 5, dayOffset: 11, templateKey: 'day11' },
  { stepNumber: 6, dayOffset: 14, templateKey: 'day14' },
];
const TEMPLATE_KEYS = DEFAULT_SCHEDULE.map((s) => s.templateKey);

class ConfigurationError extends Error {}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The currently-active version of one template. Null if somehow missing. */
async function getActiveTemplate(templateKey) {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_templates WHERE template_key = $1 AND is_active = TRUE`,
    [templateKey]
  );
  return rows[0] || null;
}

/** All six active templates, in cadence order. */
async function listActiveTemplates() {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_templates WHERE is_active = TRUE`
  );
  const byKey = new Map(rows.map((r) => [r.template_key, r]));
  return DEFAULT_SCHEDULE.map((s) => ({ ...s, template: byKey.get(s.templateKey) || null }));
}

/** Full version history for one template key, newest first. */
async function getTemplateHistory(templateKey) {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_templates WHERE template_key = $1 ORDER BY version DESC`,
    [templateKey]
  );
  return rows;
}

/**
 * Save a new, active version of a template. Never mutates an existing row.
 * Transaction: insert version = max(version)+1 with is_active=true, flip
 * the previously-active row (if any) to is_active=false.
 */
async function saveTemplateVersion({ templateKey, subject, bodyHtml, createdBy }) {
  if (!TEMPLATE_KEYS.includes(templateKey)) throw new Error(`unknown template key: ${templateKey}`);
  if (!subject || !subject.trim()) throw new Error('subject is required');
  if (!bodyHtml || !bodyHtml.trim()) throw new Error('bodyHtml is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM estimate_followup_templates WHERE template_key = $1 FOR UPDATE`,
      [templateKey]
    );
    const nextVersion = Number(maxRows[0].max_version) + 1;
    await client.query(
      `UPDATE estimate_followup_templates SET is_active = FALSE WHERE template_key = $1 AND is_active = TRUE`,
      [templateKey]
    );
    const { rows } = await client.query(
      `INSERT INTO estimate_followup_templates (template_key, version, subject, body_html, is_active, created_by)
       VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING *`,
      [templateKey, nextVersion, subject.trim(), bodyHtml, createdBy || null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Replace {{first_name}} / {{sales_rep_name}} tokens — both HTML-escaped. */
function renderTokens(text, { firstName, salesRepName }) {
  return String(text || '')
    .replace(/\{\{\s*first_name\s*\}\}/g, esc(firstName || 'there'))
    .replace(/\{\{\s*sales_rep_name\s*\}\}/g, esc(salesRepName || 'Your EC Construction Group Representative'));
}

/**
 * Build the CAN-SPAM compliance block: real physical mailing address (never
 * invented — throws ConfigurationError if unset) + a working unsubscribe
 * link. Deliberately small/unobtrusive (gray, small text) so it reads as
 * a standard footer, not as marketing chrome, consistent with the personal
 * tone of the message above it.
 */
async function buildComplianceFooterHtml(unsubscribeUrl) {
  const cfg = await companyConfig.getCompanyConfig();
  const addressParts = [cfg.company_address, [cfg.company_city, cfg.company_state].filter(Boolean).join(', '), cfg.company_zip]
    .filter(Boolean);
  if (addressParts.length === 0) {
    throw new ConfigurationError(
      'No business mailing address is configured in Company Settings (company_address/city/state/zip) — ' +
      'required by CAN-SPAM for this promotional follow-up sequence. Refusing to send rather than omit it.'
    );
  }
  const companyName = cfg.company_name || cfg.legal_name || 'EC Construction Group';
  return `
    <div style="margin-top:28px;padding-top:14px;border-top:1px solid #E2E2E2;font-size:11px;line-height:1.5;color:#8A8A8A;font-family:Arial,sans-serif;">
      <div>${esc(companyName)} &middot; ${esc(addressParts.join(', '))}</div>
      <div>You are receiving this because you requested an estimate from us. <a href="${esc(unsubscribeUrl)}" style="color:#8A8A8A;text-decoration:underline;">Unsubscribe from these follow-up emails</a>.</div>
    </div>`;
}

/**
 * Compose the full, ready-to-send HTML body + subject for one step.
 * Throws ConfigurationError (never a generic Error) when the business
 * address is unset, so callers can distinguish "fix Company Settings"
 * from an ordinary per-send failure.
 */
async function renderEmailForStep({ templateKey, firstName, salesRepName, unsubscribeUrl }) {
  const tpl = await getActiveTemplate(templateKey);
  if (!tpl) throw new Error(`no active template for key: ${templateKey}`);
  const footer = await buildComplianceFooterHtml(unsubscribeUrl);
  const body = renderTokens(tpl.body_html, { firstName, salesRepName });
  const subject = renderTokens(tpl.subject, { firstName, salesRepName });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1A1A2E;max-width:600px;">${body}${footer}</div>`;
  return { subject, html, templateVersion: tpl.version };
}

module.exports = {
  DEFAULT_SCHEDULE,
  TEMPLATE_KEYS,
  ConfigurationError,
  getActiveTemplate,
  listActiveTemplates,
  getTemplateHistory,
  saveTemplateVersion,
  renderTokens,
  buildComplianceFooterHtml,
  renderEmailForStep,
};
