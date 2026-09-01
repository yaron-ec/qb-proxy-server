/* eslint-disable no-undef */
/**
 * railwayDataAccess — Railway Postgres CRUD layer that mirrors the Base44
 * REST entity interface (list, filter, update, create, isConfigured).
 *
 * PURPOSE: drop-in replacement for lib/base44.js in the QB sync routes.
 * The QB sync code in server.js calls b44.list('Lead'), b44.update('HandoffEstimate', ...),
 * etc. This module provides the same interface but reads/writes Railway Postgres
 * tables instead of the Base44 REST API.
 *
 * TABLE NAME MAPPING:
 *   'Lead'           → 'leads'
 *   'HandoffEstimate' → 'handoff_estimates'
 *   'Activity'        → 'activities'
 *   'SyncCursor'      → 'sync_cursors'
 *   'Invoice'         → 'invoices'
 *   'CompanySettings' → 'company_settings'
 *
 * SORT MAPPING:
 *   '-created_date' → 'ORDER BY created_at DESC'
 *   'created_date'  → 'ORDER BY created_at ASC'
 *   (Base44 uses created_date; Railway uses created_at)
 *
 * JSONB FIELDS:
 *   Object values are automatically JSON.stringify()'d for JSONB columns.
 *
 * All functions throw on error (same as b44). Callers can catch to suppress.
 */
'use strict';

const db = require('../db/client');

const TABLE_MAP = {
  'Lead': 'leads',
  'HandoffEstimate': 'handoff_estimates',
  'Activity': 'activities',
  'SyncCursor': 'sync_cursors',
  'Invoice': 'invoices',
  'CompanySettings': 'company_settings',
  'Task': 'tasks',
  'Deal': 'deals',
};

function tableName(entity) {
  const t = TABLE_MAP[entity];
  if (!t) throw new Error(`railwayDataAccess: unknown entity "${entity}"`);
  return t;
}

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

// Convert a sort spec like '-created_date' to SQL ORDER BY clause.
function sortToOrderBy(sort) {
  if (!sort) return '';
  const desc = sort.startsWith('-');
  const col = (desc ? sort.slice(1) : sort).replace('created_date', 'created_at');
  return `ORDER BY ${col} ${desc ? 'DESC' : 'ASC'}`;
}

// JSONB detection: stringify object/array values for JSONB columns.
function serializeValue(val) {
  if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return JSON.stringify(val);
  }
  return val;
}

// ── list(entity, sort, limit, offset) ───────────────────────────────────────
async function list(entity, sort, limit = 100, offset = 0) {
  const table = tableName(entity);
  const orderBy = sortToOrderBy(sort) || 'ORDER BY created_at DESC';
  const sql = `SELECT * FROM ${table} ${orderBy} LIMIT $1 OFFSET $2`;
  const { rows } = await db.query(sql, [limit, offset]);
  return rows;
}

// ── filter(entity, filterObj) ────────────────────────────────────────────────
async function filter(entity, filterObj = {}) {
  const table = tableName(entity);
  const keys = Object.keys(filterObj);
  if (keys.length === 0) {
    const { rows } = await db.query(`SELECT * FROM ${table}`);
    return rows;
  }
  const where = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  const params = keys.map(k => serializeValue(filterObj[k]));
  const sql = `SELECT * FROM ${table} WHERE ${where}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

// ── update(entity, id, fields) ──────────────────────────────────────────────
// Updates by Railway UUID (id). For leads, also matches external_ref.
async function update(entity, id, fields = {}) {
  const table = tableName(entity);
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const params = keys.map(k => serializeValue(fields[k]));

  // For leads, allow update by Railway UUID or external_ref (Base44 ID).
  const whereClause = entity === 'Lead'
    ? `(id::text = $1 OR external_ref = $1)`
    : `id::text = $1`;

  const sql = `UPDATE ${table} SET ${setClauses}, updated_at = NOW() WHERE ${whereClause} RETURNING *`;
  const { rows } = await db.query(sql, [String(id), ...params]);
  return rows[0] || null;
}

// ── create(entity, fields) ───────────────────────────────────────────────────
async function create(entity, fields = {}) {
  const table = tableName(entity);
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const cols = keys.join(', ');
  const placeholders = keys.map((k, i) => `$${i + 1}`).join(', ');
  const params = keys.map(k => serializeValue(fields[k]));

  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

// ── get(entity, id) ──────────────────────────────────────────────────────────
async function get(entity, id) {
  const table = tableName(entity);
  const whereClause = entity === 'Lead'
    ? `(id::text = $1 OR external_ref = $1)`
    : `id::text = $1`;
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`, [String(id)]);
  return rows[0] || null;
}

module.exports = {
  isConfigured,
  list,
  filter,
  update,
  create,
  get,
  tableName,
};