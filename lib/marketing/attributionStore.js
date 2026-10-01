/* eslint-disable no-undef */
/**
 * attributionStore — persistence for marketing touches, per-inquiry
 * submissions and the lead-level attribution pointers.
 *
 * Invariants (enforced here AND by the database, migration 2026-48):
 *   - Touches are append-only. An identical touch (same content_hash) for the
 *     same lead is stored once (partial unique index), so replays and repeat
 *     submissions from the same browser never duplicate it.
 *   - One lead_submissions row per inquiry, idempotent on external_ref.
 *   - leads.first_touch_id is set once and never overwritten (DB trigger);
 *     only correctFirstTouch() — explicit, audited — can change it.
 *   - leads.last_touch_id only moves FORWARD in time and only to a
 *     meaningful (non-Direct) touch.
 *   - leads.conversion_touch_id = the touch of the inquiry that CREATED the
 *     lead; set once.
 *   - A merge moves every touch, submission, status and qualification event
 *     to the survivor (marked merged_from_lead_id), never deletes one, and
 *     never overwrites the survivor's first touch.
 *
 * Every write here runs in one transaction on a client from the pool and
 * never spans a network call.
 */
'use strict';

const TOUCH_COLUMNS = [
  'occurred_at', 'channel_code', 'classifier_version', 'source', 'medium', 'campaign', 'campaign_id',
  'landing_page', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'gad_source', 'gad_campaignid',
];

/**
 * Attach who/why to the lead status history trigger for the current
 * transaction only (set_config(..., true) — reverts at COMMIT/ROLLBACK).
 */
async function setChangeContext(client, { actor, source, reason } = {}) {
  await client.query(
    `SELECT set_config('ec.actor', $1, true), set_config('ec.change_source', $2, true), set_config('ec.status_reason', $3, true)`,
    [actor ? String(actor).slice(0, 200) : '', source ? String(source).slice(0, 60) : '', reason ? String(reason).slice(0, 60) : '']
  );
}

/** Insert (or find) one touch for a lead. Returns { id, occurred_at, channel_code }. */
async function upsertTouch(client, leadId, touch, { originSystem, touchType = 'web_visit' }) {
  const cols = ['lead_id', 'touch_type', 'origin_system', 'content_hash', ...TOUCH_COLUMNS];
  const vals = [leadId, touchType, originSystem, touch.content_hash, ...TOUCH_COLUMNS.map((c) => (touch[c] === undefined ? null : touch[c]))];
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const ins = await client.query(
    `INSERT INTO marketing_touches (${cols.join(', ')}) VALUES (${ph})
     ON CONFLICT (lead_id, content_hash) WHERE merged_from_lead_id IS NULL DO NOTHING
     RETURNING id, occurred_at, channel_code`, vals);
  if (ins.rows[0]) return ins.rows[0];
  const found = await client.query(
    `SELECT id, occurred_at, channel_code FROM marketing_touches
      WHERE lead_id = $1 AND content_hash = $2 AND merged_from_lead_id IS NULL`, [leadId, touch.content_hash]);
  return found.rows[0];
}

/**
 * Record one website inquiry (idempotent on externalRef): its touches, its
 * lead_submissions row, and the lead pointers.
 *
 * @param pool       pg Pool
 * @param p.leadId   CRM lead the inquiry belongs to (created or matched)
 * @param p.externalRef  the website delivery reference (ec-website-lead-<id>)
 * @param p.action   'created' | 'created_possible_duplicate' | 'matched_existing'
 * @param p.lead     mapped lead fields (project_type, message, source, submitted_at)
 * @param p.attribution  output of websiteAttribution.mapWebsiteAttribution
 * @returns { submission_id, duplicate, touch_ids: { first, last, conversion } }
 */
async function recordWebsiteInquiry(pool, { leadId, externalRef, action, lead = {}, attribution }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadRow = (await client.query(
      `SELECT l.id, l.status, l.first_touch_id, l.last_touch_id, l.conversion_touch_id, o.display_name AS owner_name,
              lt.occurred_at AS last_touch_at
         FROM leads l
         LEFT JOIN owners o ON o.id = l.owner_id
         LEFT JOIN marketing_touches lt ON lt.id = l.last_touch_id
        WHERE l.id = $1 FOR UPDATE OF l`, [leadId])).rows[0];
    if (!leadRow) throw new Error(`recordWebsiteInquiry: lead ${leadId} not found`);

    const existing = (await client.query('SELECT id, first_touch_id, last_touch_id, conversion_touch_id FROM lead_submissions WHERE external_ref = $1', [externalRef])).rows[0];
    if (existing) {
      await client.query('COMMIT');
      return { submission_id: existing.id, duplicate: true, touch_ids: { first: existing.first_touch_id, last: existing.last_touch_id, conversion: existing.conversion_touch_id } };
    }

    const t = (attribution && attribution.touches) || {};
    const ids = {};
    const rows = {};
    for (const role of ['first', 'last', 'conversion']) {
      if (!t[role]) continue;
      const r = await upsertTouch(client, leadId, t[role], { originSystem: 'website' });
      ids[role] = r.id;
      rows[role] = r;
    }

    const inq = (attribution && attribution.inquiry) || {};
    const cnt = (await client.query('SELECT COUNT(*)::int AS n FROM lead_submissions WHERE lead_id = $1', [leadId])).rows[0].n;
    const reactivation = ['Lost', 'DNQ', 'No show'].includes(leadRow.status);
    const sub = (await client.query(
      `INSERT INTO lead_submissions
         (lead_id, external_ref, submitted_at, source, form_type, project_type, message,
          assigned_rep_at_time, lead_status_at_time, submission_number, was_reactivation, previous_status,
          origin_system, intake_action, raw_source, website_lead_id, website_submission_id, page_url, conversion_page,
          first_touch_id, last_touch_id, conversion_touch_id, consent_sms, consent_email, consent_gpc)
       VALUES ($1,$2,COALESCE($3::timestamptz, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,'website',$13,$4,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (external_ref) DO NOTHING
       RETURNING id`,
      [leadId, externalRef, lead.submitted_at || null, lead.source || 'Website', inq.form_id || null,
        lead.project_type || null, lead.message || null, leadRow.owner_name || null, leadRow.status || null,
        cnt + 1, reactivation, reactivation ? leadRow.status : null,
        action, inq.website_lead_id || null, inq.website_submission_id || null, inq.page_url || null, inq.conversion_page || null,
        ids.first || null, ids.last || null, ids.conversion || null,
        inq.consent_sms === true, inq.consent_email === undefined ? null : inq.consent_email,
        inq.consent_gpc === undefined ? null : inq.consent_gpc])).rows[0];

    // Lead pointers.
    const sets = [];
    const params = [];
    const firstCandidate = ids.first || ids.conversion || ids.last || null;
    if (!leadRow.first_touch_id && firstCandidate) { params.push(firstCandidate); sets.push(`first_touch_id = $${params.length}`); }
    if (ids.last && rows.last && (!leadRow.last_touch_at || new Date(rows.last.occurred_at) > new Date(leadRow.last_touch_at))) {
      params.push(ids.last); sets.push(`last_touch_id = $${params.length}`);
    }
    if (!leadRow.conversion_touch_id && ids.conversion && action !== 'matched_existing') {
      params.push(ids.conversion); sets.push(`conversion_touch_id = $${params.length}`);
    }
    if (sets.length) {
      params.push(leadId);
      await client.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    await client.query('COMMIT');
    return { submission_id: sub ? sub.id : null, duplicate: !sub, touch_ids: { first: ids.first || null, last: ids.last || null, conversion: ids.conversion || null } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The ONLY way to change a lead's first touch once set: explicit, audited.
 * touchId must belong to the lead (or be null to clear).
 */
async function correctFirstTouch(pool, { leadId, touchId, actor, reason }) {
  if (!actor || !reason) throw new Error('correctFirstTouch requires actor and reason');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lead = (await client.query('SELECT id, first_touch_id FROM leads WHERE id = $1 FOR UPDATE', [leadId])).rows[0];
    if (!lead) throw new Error('lead not found');
    if (touchId) {
      const own = (await client.query('SELECT 1 FROM marketing_touches WHERE id = $1 AND lead_id = $2', [touchId, leadId])).rows[0];
      if (!own) throw new Error('touch does not belong to this lead');
    }
    await client.query(`SELECT set_config('ec.attribution_correction', 'on', true)`);
    await client.query('UPDATE leads SET first_touch_id = $1 WHERE id = $2', [touchId || null, leadId]);
    await client.query(
      `INSERT INTO lead_attribution_audit (lead_id, action, previous_touch_id, new_touch_id, actor, reason)
       VALUES ($1, 'first_touch_correction', $2, $3, $4, $5)`,
      [leadId, lead.first_touch_id, touchId || null, String(actor).slice(0, 200), String(reason).slice(0, 1000)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Merge support — runs INSIDE the caller's merge transaction (client).
 * Moves all attribution and funnel history from mergedId to survivorId,
 * keeping lineage, and resolves the survivor's pointers without ever
 * overwriting its first touch.
 */
async function moveAttributionForMerge(client, { survivorId, mergedId, actor }) {
  const stats = {};
  const s = (await client.query(
    `SELECT l.first_touch_id, l.last_touch_id, l.conversion_touch_id, lt.occurred_at AS last_at
       FROM leads l LEFT JOIN marketing_touches lt ON lt.id = l.last_touch_id WHERE l.id = $1`, [survivorId])).rows[0];
  const m = (await client.query(
    `SELECT l.first_touch_id, l.last_touch_id, l.conversion_touch_id, lt.occurred_at AS last_at
       FROM leads l LEFT JOIN marketing_touches lt ON lt.id = l.last_touch_id WHERE l.id = $1`, [mergedId])).rows[0];

  stats.touches = (await client.query(
    `UPDATE marketing_touches SET lead_id = $1, merged_from_lead_id = COALESCE(merged_from_lead_id, $2) WHERE lead_id = $2`,
    [survivorId, mergedId])).rowCount || 0;
  // lead_submissions are moved (with merged_from_lead_id) by routes/mergeLeads.js.
  stats.status_events = (await client.query(
    `UPDATE lead_status_events SET lead_id = $1, merged_from_lead_id = COALESCE(merged_from_lead_id, $2) WHERE lead_id = $2`,
    [survivorId, mergedId])).rowCount || 0;
  stats.qualification_events = (await client.query(
    `UPDATE lead_qualification_events SET lead_id = $1, merged_from_lead_id = COALESCE(merged_from_lead_id, $2) WHERE lead_id = $2`,
    [survivorId, mergedId])).rowCount || 0;

  const sets = [];
  const params = [];
  if (!s.first_touch_id && m.first_touch_id) {
    params.push(m.first_touch_id); sets.push(`first_touch_id = $${params.length}`);
    await client.query(
      `INSERT INTO lead_attribution_audit (lead_id, action, previous_touch_id, new_touch_id, actor, reason, details)
       VALUES ($1, 'merge_adopted_first_touch', NULL, $2, $3, 'survivor had no first touch', $4)`,
      [survivorId, m.first_touch_id, actor || null, JSON.stringify({ merged_lead_id: mergedId })]);
  } else if (s.first_touch_id && m.first_touch_id) {
    await client.query(
      `INSERT INTO lead_attribution_audit (lead_id, action, previous_touch_id, new_touch_id, actor, reason, details)
       VALUES ($1, 'merge_kept_survivor_first_touch', $2, $2, $3, 'survivor first touch is never overwritten by a merge', $4)`,
      [survivorId, s.first_touch_id, actor || null, JSON.stringify({ merged_lead_id: mergedId, merged_first_touch_id: m.first_touch_id })]);
  }
  if (m.last_touch_id && (!s.last_touch_id || (m.last_at && s.last_at && new Date(m.last_at) > new Date(s.last_at)))) {
    params.push(m.last_touch_id); sets.push(`last_touch_id = $${params.length}`);
  }
  if (!s.conversion_touch_id && m.conversion_touch_id) {
    params.push(m.conversion_touch_id); sets.push(`conversion_touch_id = $${params.length}`);
  }
  if (sets.length) {
    params.push(survivorId);
    await client.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  return stats;
}

module.exports = { setChangeContext, upsertTouch, recordWebsiteInquiry, correctFirstTouch, moveAttributionForMerge, TOUCH_COLUMNS };
