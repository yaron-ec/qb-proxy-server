#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * applySourceMappings.js — maintain the raw-source → channel / provider
 * mapping layer (migration 2026-48) from a JSON file of THIS installation's
 * decisions. Installation-specific names (lead providers, legacy source
 * labels) live in that data file, never in code.
 *
 *   FILE=docs/marketing/ec-source-mappings.json node scripts/marketing/applySourceMappings.js
 *   APPLY=1 FILE=... node scripts/marketing/applySourceMappings.js
 *
 * File shape:
 *   { "providers": [ { "name": "…", "kind": "partner|referral_source|other", "notes": "…" } ],
 *     "mappings":  [ { "raw_source": "…", "channel": "<marketing_channels.code>",
 *                      "provider": "<provider name, optional>", "notes": "…" } ] }
 *
 * REPORT-ONLY by default (prints what would change). APPLY=1 writes in one
 * transaction. Never touches leads.source or any lead row: legacy values stay
 * exactly as stored and are resolved through lead_attribution_v.
 * Env: DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');

function loadFile(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const errors = [];
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const mappings = Array.isArray(data.mappings) ? data.mappings : [];
  const names = new Set(providers.map((p) => String(p.name || '').trim().toLowerCase()));
  for (const p of providers) {
    if (!p.name || !String(p.name).trim()) errors.push('provider without name');
    if (p.kind && !['partner', 'referral_source', 'other'].includes(p.kind)) errors.push(`provider ${p.name}: invalid kind ${p.kind}`);
  }
  for (const m of mappings) {
    if (!m.raw_source || !String(m.raw_source).trim()) errors.push('mapping without raw_source');
    if (!m.channel) errors.push(`mapping ${m.raw_source}: channel required`);
    if (m.provider && !names.has(String(m.provider).trim().toLowerCase())) errors.push(`mapping ${m.raw_source}: provider ${m.provider} not declared in providers`);
  }
  return { providers, mappings, errors };
}

async function apply(db, { providers, mappings }, { write = false, actor = 'applySourceMappings' } = {}) {
  const channels = new Set((await db.query('SELECT code FROM marketing_channels')).rows.map((r) => r.code));
  const bad = mappings.filter((m) => !channels.has(m.channel)).map((m) => `${m.raw_source}: unknown channel ${m.channel}`);
  if (bad.length) throw new Error(`Unknown channel codes: ${bad.join('; ')}`);
  const report = { mode: write ? 'APPLY' : 'REPORT-ONLY', providers: [], mappings: [] };
  const client = write ? await db.connect() : db;
  try {
    if (write) await client.query('BEGIN');
    const providerIds = {};
    for (const p of providers) {
      const name = String(p.name).trim();
      const existing = (await client.query('SELECT id, kind FROM lead_providers WHERE lower(name) = lower($1)', [name])).rows[0];
      if (existing) {
        providerIds[name.toLowerCase()] = existing.id;
        report.providers.push({ name, action: 'exists' });
      } else if (write) {
        const r = await client.query('INSERT INTO lead_providers (name, kind, notes) VALUES ($1, $2, $3) RETURNING id', [name, p.kind || 'partner', p.notes || null]);
        providerIds[name.toLowerCase()] = r.rows[0].id;
        report.providers.push({ name, action: 'created' });
      } else {
        report.providers.push({ name, action: 'would_create' });
      }
    }
    for (const m of mappings) {
      const raw = String(m.raw_source).trim();
      const key = raw.toLowerCase();
      const providerId = m.provider ? providerIds[String(m.provider).trim().toLowerCase()] || null : null;
      const cur = (await client.query('SELECT channel_code, provider_id FROM lead_source_mappings WHERE raw_source_key = $1', [key])).rows[0];
      const same = cur && cur.channel_code === m.channel && String(cur.provider_id || '') === String(providerId || '');
      const action = !cur ? 'create' : same ? 'unchanged' : 'update';
      report.mappings.push({ raw_source: raw, channel: m.channel, provider: m.provider || null, action: write ? action : `would_${action}` });
      if (write && action !== 'unchanged') {
        await client.query(
          `INSERT INTO lead_source_mappings (raw_source_key, raw_source, channel_code, provider_id, notes, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (raw_source_key) DO UPDATE SET channel_code = EXCLUDED.channel_code, provider_id = EXCLUDED.provider_id,
             notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [key, raw, m.channel, providerId, m.notes || null, actor]);
      }
    }
    if (write) await client.query('COMMIT');
    return report;
  } catch (e) {
    if (write) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (write) client.release();
  }
}

async function main() {
  const file = process.env.FILE;
  if (!file) { console.error('FILE=<mappings.json> is required'); process.exit(2); }
  const data = loadFile(file);
  if (data.errors.length) { console.error(JSON.stringify({ errors: data.errors }, null, 2)); process.exit(2); }
  const { pool } = require('../../db/client');
  try {
    const report = await apply(pool, data, { write: process.env.APPLY === '1' });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { loadFile, apply };
