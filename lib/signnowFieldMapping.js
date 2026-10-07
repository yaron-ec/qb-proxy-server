/* eslint-disable no-undef */
'use strict';

/**
 * signnowFieldMapping — admin-configurable CRM -> SignNow template field
 * mapping layer (CRM STABILITY PHASE, completion pass, Section A).
 *
 * BACKGROUND: SignNow's documented public REST API has no persistent
 * "Contacts" resource (confirmed via docs.signnow.com's own reference
 * categories — User/OAuth/Document/Template/Folder/Document Group/Webhook/
 * Embedded; the Help Center describes Contacts as a web-app-only concept).
 * The already-working field-invite flow (lib/signnowClient.js#sendInvite ->
 * POST /document/{id}/invite) already supplies recipient email/name/role
 * directly, with no Contact object required — so there was nothing to
 * "sync" there. The genuinely missing piece was CRM data -> template TEXT
 * fields (name, address, phone, project amount, etc.), so staff don't
 * re-type information already in the CRM. This module is that layer.
 *
 * ARCHITECTURE (CLAUDE.md requirement: "do NOT scatter SignNow template
 * field IDs throughout frontend components"):
 *   - CRM_SOURCES is the one allowlist of CRM values a mapping is allowed
 *     to read (never arbitrary/eval'd) — generic, reusable for any future
 *     template, not just the HIC.
 *   - signnow_template_field_mappings (Postgres) is the per-template,
 *     admin-configured link from a real SignNow field name to one
 *     CRM_SOURCES key, with a `required` flag.
 *   - A real HIC template's actual field names are account-specific and
 *     unknowable without live SignNow credentials (none exist in this
 *     environment) — this table starts empty; an admin fills it in via
 *     the SignNow settings UI once a template's live fields can be seen
 *     (GET /api/v1/signnow/field-mappings/:templateId after a first
 *     Prepare shows the document's actual current field names).
 *
 * This is a PURE, side-effect-free data-resolution layer except for the
 * mapping CRUD functions, which only touch
 * signnow_template_field_mappings — never lead/deal data.
 */
const { query } = require('../db/client');

// Allowlisted CRM sources a template field may be mapped to. Add new
// entries here only — never let a mapping row reach into arbitrary CRM
// data. `get(ctx)` must be a pure function of { lead, deal }.
const CRM_SOURCES = Object.freeze({
  lead_first_name: { label: 'Customer First Name', get: (ctx) => ctx.lead?.first_name || '' },
  lead_last_name: { label: 'Customer Last Name', get: (ctx) => ctx.lead?.last_name || '' },
  lead_full_name: { label: 'Customer Full Name', get: (ctx) => `${ctx.lead?.first_name || ''} ${ctx.lead?.last_name || ''}`.trim() },
  lead_email: { label: 'Customer Email', get: (ctx) => ctx.lead?.email || '' },
  lead_phone: { label: 'Customer Phone', get: (ctx) => ctx.lead?.phone || '' },
  lead_street_address: { label: 'Street Address', get: (ctx) => ctx.lead?.property_address || '' },
  lead_city: { label: 'City', get: (ctx) => ctx.lead?.city || '' },
  lead_state: { label: 'State', get: (ctx) => ctx.lead?.state || '' },
  lead_zip: { label: 'ZIP', get: (ctx) => ctx.lead?.zip || '' },
  job_address_full: {
    label: 'Job / Project Address (full)',
    get: (ctx) => [ctx.lead?.property_address, ctx.lead?.city, ctx.lead?.state, ctx.lead?.zip].filter(Boolean).join(', '),
  },
  deal_project_name: { label: 'Project / Deal Name', get: (ctx) => ctx.deal?.name || '' },
  deal_amount: { label: 'Contract / Project Amount', get: (ctx) => (ctx.deal?.amount != null ? String(ctx.deal.amount) : '') },
  deal_sold_date: {
    label: 'Sold Date',
    get: (ctx) => (ctx.deal?.sold_date ? new Date(ctx.deal.sold_date).toISOString().slice(0, 10) : ''),
  },
  today_date: { label: "Today's Date", get: () => new Date().toISOString().slice(0, 10) },
});

function listCrmSources() {
  return Object.entries(CRM_SOURCES).map(([key, v]) => ({ key, label: v.label }));
}

/** All configured field mappings for one template, in creation order. */
async function getMappingsForTemplate(templateId) {
  const { rows } = await query(
    `SELECT id, template_id, signnow_field_name, field_label, crm_source, required, created_at, updated_at
     FROM signnow_template_field_mappings WHERE template_id = $1 ORDER BY created_at ASC`,
    [templateId]
  );
  return rows;
}

/**
 * Replace ALL mappings for a template with the given list (admin save).
 * Validates every crm_source against the allowlist before writing anything
 * — a typo'd source must never silently become a no-op mapping.
 */
async function setMappingsForTemplate(templateId, mappings) {
  if (!templateId) throw new Error('templateId required');
  const list = Array.isArray(mappings) ? mappings : [];
  for (const m of list) {
    if (!m.signnow_field_name) throw new Error('each mapping requires signnow_field_name');
    if (!CRM_SOURCES[m.crm_source]) throw new Error(`unknown crm_source: ${m.crm_source}`);
  }
  const client = await require('../db/client').pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM signnow_template_field_mappings WHERE template_id = $1', [templateId]);
    for (const m of list) {
      await client.query(
        `INSERT INTO signnow_template_field_mappings
           (template_id, signnow_field_name, field_label, crm_source, required)
         VALUES ($1, $2, $3, $4, $5)`,
        [templateId, m.signnow_field_name, m.field_label || CRM_SOURCES[m.crm_source].label, m.crm_source, !!m.required]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return getMappingsForTemplate(templateId);
}

/**
 * Resolve a template's configured mappings against actual CRM data (lead,
 * optional deal), WITHOUT making any SignNow API call — this is the
 * pre-flight validator required by Section A2: "the CRM must identify
 * exactly what is missing BEFORE creating a malformed contract."
 *
 * Returns:
 *   { missing: [{ signnow_field_name, field_label }],   // required + empty
 *     resolved: [{ signnow_field_name, value }] }        // every mapped value (incl. optional empties, which the caller omits from prefill)
 */
function resolveMappingValues(mappings, ctx) {
  const missing = [];
  const resolved = [];
  for (const m of mappings || []) {
    const source = CRM_SOURCES[m.crm_source];
    const value = source ? String(source.get(ctx) || '').trim() : '';
    resolved.push({ signnow_field_name: m.signnow_field_name, value });
    if (m.required && !value) {
      missing.push({ signnow_field_name: m.signnow_field_name, field_label: m.field_label || m.signnow_field_name });
    }
  }
  return { missing, resolved };
}

module.exports = {
  CRM_SOURCES,
  listCrmSources,
  getMappingsForTemplate,
  setMappingsForTemplate,
  resolveMappingValues,
};
