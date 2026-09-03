/* eslint-disable no-undef */
/**
 * Migration Safety regression tests.
 *
 * Verifies that db/migrate.js:
 *   1. Uses pg_advisory_lock to prevent concurrent migration runs
 *   2. Uses schema_migrations table to track applied migrations
 *   3. Skips already-applied migrations
 *   4. Failed migration prevents startup (exit(1))
 *   5. Records checksum for each applied migration
 *   6. Releases advisory lock on completion (even on error)
 *
 * Verifies migration 2026-28:
 *   7. Creates schema_migrations table
 *   8. Creates index on invoices.deal_id
 *   9. Is idempotent (IF NOT EXISTS)
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Test 1: db/migrate.js uses advisory lock ──────────────────────────────
test('Migration safety: db/migrate.js uses pg_advisory_lock', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(src.includes('pg_advisory_lock'), 'must acquire advisory lock');
  assert.ok(src.includes('pg_advisory_unlock'), 'must release advisory lock');
  assert.ok(src.includes('ADVISORY_LOCK_KEY'), 'must use a stable lock key');
});

// ── Test 2: db/migrate.js uses schema_migrations table ────────────────────
test('Migration safety: db/migrate.js uses schema_migrations table', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(src.includes('schema_migrations'), 'must use schema_migrations table');
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS schema_migrations'), 'must create schema_migrations table');
});

// ── Test 3: db/migrate.js skips already-applied migrations ────────────────
test('Migration safety: db/migrate.js skips already-applied migrations', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(src.includes('SELECT filename FROM schema_migrations'), 'must check if migration already applied');
  assert.ok(src.includes('skipped++'), 'must track skipped migrations');
  assert.ok(src.includes('continue'), 'must skip already-applied files');
});

// ── Test 4: Failed migration prevents startup ────────────────────────────
test('Migration safety: failed migration prevents startup (exit(1))', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(src.includes('process.exit(1)'), 'must exit(1) on failure');
  assert.ok(src.includes('process.exit(0)'), 'must exit(0) on success');
  assert.ok(src.includes('[migrate] FAILED:'), 'must log failure');
});

// ── Test 5: Records checksum for each applied migration ───────────────────
test('Migration safety: records checksum for each applied migration', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(src.includes('checksum'), 'must compute checksum');
  assert.ok(src.includes('createHash'), 'must use crypto.createHash');
  assert.ok(src.includes('INSERT INTO schema_migrations'), 'must record applied migration');
});

// ── Test 6: Releases advisory lock on completion ──────────────────────────
test('Migration safety: releases advisory lock in finally block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
  assert.ok(/finally[\s\S]*?pg_advisory_unlock/.test(src), 'must release lock in finally block');
});

// ── Test 7: Migration 2026-28 creates schema_migrations table ──────────────
test('Migration safety: 2026-28 creates schema_migrations table', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '2026-28-financial-isolation-and-migration-safety.sql'), 'utf8');
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS schema_migrations'), 'must create schema_migrations table');
  assert.ok(migration.includes('filename'), 'must have filename column');
  assert.ok(migration.includes('applied_at'), 'must have applied_at column');
  assert.ok(migration.includes('checksum'), 'must have checksum column');
});

// ── Test 8: Migration 2026-28 creates index on invoices.deal_id ────────────
test('Migration safety: 2026-28 creates index on invoices.deal_id', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '2026-28-financial-isolation-and-migration-safety.sql'), 'utf8');
  assert.ok(migration.includes('invoices_deal_id_idx'), 'must create invoices_deal_id_idx');
  assert.ok(/CREATE INDEX IF NOT EXISTS invoices_deal_id_idx/.test(migration), 'must use IF NOT EXISTS');
});

// ── Test 9: All migration files are idempotent ─────────────────────────────
test('Migration safety: all migration files use idempotent SQL', () => {
  const dir = path.join(ROOT, 'db', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Every CREATE TABLE must use IF NOT EXISTS
    const createTableMatches = sql.match(/CREATE TABLE\s+(?!IF NOT EXISTS)\w+/gi) || [];
    assert.ok(createTableMatches.length === 0, `${f}: CREATE TABLE must use IF NOT EXISTS`);
    // Every CREATE INDEX must use IF NOT EXISTS
    const createIndexMatches = sql.match(/CREATE INDEX\s+(?!IF NOT EXISTS)\w+/gi) || [];
    assert.ok(createIndexMatches.length === 0, `${f}: CREATE INDEX must use IF NOT EXISTS`);
  }
});

// ── Test 10: Dockerfile runs migrate before server ────────────────────────
test('Migration safety: Dockerfile runs db/migrate.js before server.js', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('node db/migrate.js && node server.js'),
    'Dockerfile CMD must run migrate before server');
});