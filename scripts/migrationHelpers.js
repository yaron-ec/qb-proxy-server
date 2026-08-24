/* eslint-disable no-undef */
'use strict';
/**
 * migrationHelpers.js — Shared utilities for all Base44→Railway migration scripts.
 *
 * Provides:
 *   - fetchBase44Entity: paginated Base44 REST API reader
 *   - countBase44Entity: count-only fetch for preflight
 *   - buildLeadIdCache: Base44 Lead ObjectId → Railway leads.id (via external_ref)
 *   - buildDealIdCache: Base44 Deal ObjectId → Railway deals.id (via legacy_base44_id)
 *   - buildExpenseIdCache: Base44 DealExpense ObjectId → Railway deal_expenses.id (via external_ref)
 *   - resolveOwnerId: assigned_rep string → Railway owners.id
 */
const { query } = require('../db/client');

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://api.base44.com';
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

function hasBase44Creds() {
  return !!(BASE44_APP_ID && BASE44_API_KEY);
}

async function fetchBase44Entity(entityName, limit = 500) {
  if (!hasBase44Creds()) throw new Error('BASE44_APP_ID and BASE44_API_KEY required');
  const all = [];
  let offset = 0;
  while (true) {
    const url = `${BASE44_API_URL}/entities/${entityName}?limit=${limit}&offset=${offset}&sort=-created_date`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID },
    });
    if (!res.ok) throw new Error(`Base44 API ${res.status} for ${entityName}`);
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.items || []);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

async function countBase44Entity(entityName) {
  if (!hasBase44Creds()) return null;
  try {
    const items = await fetchBase44Entity(entityName);
    return items.length;
  } catch { return null; }
}

async function buildLeadIdCache() {
  const { rows } = await query('SELECT id, external_ref FROM leads WHERE external_ref IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.external_ref)] = r.id;
  return cache;
}

async function buildDealIdCache() {
  const { rows } = await query('SELECT id, legacy_base44_id FROM deals WHERE legacy_base44_id IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.legacy_base44_id)] = r.id;
  return cache;
}

async function buildExpenseIdCache() {
  const { rows } = await query('SELECT id, external_ref FROM deal_expenses WHERE external_ref IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.external_ref)] = r.id;
  return cache;
}

async function buildOwnerCache() {
  const { rows } = await query('SELECT id, display_name, email FROM owners WHERE is_active = true');
  const cache = {};
  for (const r of rows) {
    const nameKey = (r.display_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (nameKey) cache[nameKey] = r.id;
    if (r.email) cache[r.email.toLowerCase()] = r.id;
  }
  return cache;
}

function resolveOwnerId(assignedRep, ownerCache) {
  if (!assignedRep) return null;
  const key = String(assignedRep).toLowerCase().replace(/\s+/g, ' ').trim();
  return ownerCache[key] || null;
}

module.exports = {
  BASE44_API_URL, BASE44_APP_ID, BASE44_API_KEY,
  hasBase44Creds,
  fetchBase44Entity, countBase44Entity,
  buildLeadIdCache, buildDealIdCache, buildExpenseIdCache, buildOwnerCache,
  resolveOwnerId,
};