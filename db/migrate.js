#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * db/migrate.js - dedicated schema migration entry point (Phase 1).
 * Applies db/schema.sql (email_send_claims, email_send_logs, users,
 * refresh_tokens) idempotently. Safe to re-run.
 * The server does NOT run this automatically. Run BEFORE starting the service:
 *   node db/migrate.js        (or)   npm run migrate
 * Exit: 0 = ensured; 1 = failed.
 */
'use strict';
const db = require('./client');
db.ensureSchema()
  .then(() => { console.log('[migrate] schema ensured'); return db.pool.end(); })
  .then(() => process.exit(0))
  .catch((e) => { console.error('[migrate] FAILED:', e.message); db.pool.end().finally(() => process.exit(1)); });
