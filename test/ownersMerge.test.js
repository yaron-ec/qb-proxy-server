/* eslint-disable no-undef */
'use strict';

/**
 * ownersMerge.test.js — GET /api/v1/owners/all (read-only audit),
 * GET /api/v1/owners/:mergeId/merge-preview, and POST /api/v1/owners/merge
 * (transactional duplicate-owner consolidation).
 *
 * Production problem: two Owner Directory rows exist for the same real
 * person (Yaron Drilevich) — one with the canonical company email, one with
 * a legacy personal address — and there was no safe way to consolidate them
 * (only a destructive delete, which would orphan every lead/appointment/
 * deal/task/commission still pointing at the duplicate). This suite proves
 * the merge repoints every live reference, preserves historical/audit text
 * untouched, respects the appointments no-double-booking EXCLUDE
 * constraint, is transactional (all-or-nothing), is idempotent on repeat,
 * and is admin-only throughout.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer admin') && !auth.startsWith('Bearer nonadmin')) return res.status(401).json({ error: 'unauthorized' });
    req.user = auth.startsWith('Bearer nonadmin')
      ? { sub: 'u2', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' }
      : { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden: insufficient role' });
    next();
  },
} };

// ── In-memory relational mock, with real BEGIN/COMMIT/ROLLBACK semantics ───
let db;
function freshDb() {
  return {
    owners: [
      { id: 'yaron-canonical', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich', is_active: true, merged_into_owner_id: null, merged_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'yaron-legacy', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true, merged_into_owner_id: null, merged_at: null, created_at: '2020-01-01T00:00:00Z' },
      { id: 'michelle', email: 'michelle@ecconstructiongroup.com', display_name: 'Michelle Roitman Drilevich', is_active: true, merged_into_owner_id: null, merged_at: null, created_at: '2026-01-01T00:00:00Z' },
    ],
    leads: [
      { id: 'lead-1', owner_id: 'yaron-legacy' },
      { id: 'lead-2', owner_id: 'yaron-legacy' },
      { id: 'lead-3', owner_id: 'yaron-canonical' },
    ],
    appointments: [
      { id: 'appt-1', owner_id: 'yaron-legacy', status: 'scheduled', start: 100, end: 200 },
    ],
    deals: [
      { id: 'deal-1', assigned_rep: 'Yaron Drilevich' },
    ],
    tasks: [
      { id: 'task-1', assigned_to: 'Yaron Drilevich' },
    ],
    deal_commissions: [
      { id: 'comm-1', recipient_name: 'Yaron Drilevich' },
    ],
    lead_submissions: [
      { id: 'sub-1', assigned_rep_at_time: 'Yaron Drilevich' },
    ],
    appointment_events: [
      { id: 'ev-1', actor: 'Yaron Drilevich' },
    ],
  };
}
let snapshot = null;
function reset() { db = freshDb(); snapshot = null; }
reset();

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

async function mockQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  if (/^BEGIN$/i.test(s)) { snapshot = JSON.parse(JSON.stringify(db)); return { rows: [] }; }
  if (/^COMMIT$/i.test(s)) { snapshot = null; return { rows: [] }; }
  if (/^ROLLBACK$/i.test(s)) { if (snapshot) db = snapshot; snapshot = null; return { rows: [] }; }

  // GET /
  if (/^SELECT id, email, display_name, is_active\s+FROM owners\s+WHERE is_active = true/i.test(s)) {
    return { rows: db.owners.filter(o => o.is_active) };
  }
  // GET /all — owners list
  if (/^SELECT id, email, display_name, is_active, merged_into_owner_id, merged_at, created_at FROM owners/i.test(s)) {
    return { rows: db.owners };
  }
  if (/^SELECT owner_id, COUNT\(\*\)::int AS c FROM leads GROUP BY owner_id/i.test(s)) {
    const m = new Map();
    for (const l of db.leads) m.set(l.owner_id, (m.get(l.owner_id) || 0) + 1);
    return { rows: [...m.entries()].map(([owner_id, c]) => ({ owner_id, c })) };
  }
  if (/^SELECT owner_id, COUNT\(\*\)::int AS c FROM appointments GROUP BY owner_id/i.test(s)) {
    const m = new Map();
    for (const a of db.appointments) m.set(a.owner_id, (m.get(a.owner_id) || 0) + 1);
    return { rows: [...m.entries()].map(([owner_id, c]) => ({ owner_id, c })) };
  }
  if (/^SELECT lower\(assigned_rep\) AS name, COUNT\(\*\)::int AS c FROM deals/i.test(s)) {
    const m = new Map();
    for (const d of db.deals) if (d.assigned_rep) m.set(d.assigned_rep.toLowerCase(), (m.get(d.assigned_rep.toLowerCase()) || 0) + 1);
    return { rows: [...m.entries()].map(([name, c]) => ({ name, c })) };
  }
  if (/^SELECT lower\(assigned_to\) AS name, COUNT\(\*\)::int AS c FROM tasks/i.test(s)) {
    const m = new Map();
    for (const t of db.tasks) if (t.assigned_to) m.set(t.assigned_to.toLowerCase(), (m.get(t.assigned_to.toLowerCase()) || 0) + 1);
    return { rows: [...m.entries()].map(([name, c]) => ({ name, c })) };
  }
  if (/^SELECT lower\(recipient_name\) AS name, COUNT\(\*\)::int AS c FROM deal_commissions/i.test(s)) {
    const m = new Map();
    for (const c2 of db.deal_commissions) if (c2.recipient_name) m.set(c2.recipient_name.toLowerCase(), (m.get(c2.recipient_name.toLowerCase()) || 0) + 1);
    return { rows: [...m.entries()].map(([name, c]) => ({ name, c })) };
  }

  // PATCH /:id
  if (/^UPDATE owners SET/i.test(s) && /RETURNING/i.test(s) && !/merged_into_owner_id = \$1/.test(s)) {
    const id = params[params.length - 1];
    const o = db.owners.find(x => x.id === id);
    if (!o) return { rows: [] };
    const setsEmail = /email = \$/.test(s);
    const setsName = /display_name = \$/.test(s);
    const setsActive = /is_active = \$/.test(s);
    let i = 0;
    if (setsEmail) {
      const newEmail = params[i++];
      if (db.owners.some(x => x.id !== id && x.email === newEmail)) {
        const err = new Error('duplicate key value violates unique constraint "owners_email_key"');
        err.code = '23505';
        throw err;
      }
      o.email = newEmail;
    }
    if (setsName) { o.display_name = params[i++]; }
    if (setsActive) { o.is_active = params[i++]; }
    return { rows: [{ ...o }] };
  }

  // owners lookup by id(s)
  if (/^SELECT (\*|id, email, display_name, is_active, merged_into_owner_id) FROM owners WHERE id IN \(\$1, \$2\)/i.test(s)) {
    return { rows: db.owners.filter(o => params.includes(o.id)) };
  }

  // Preview / merge counts scoped to one owner_id
  if (/^SELECT COUNT\(\*\)::int c FROM leads WHERE owner_id = \$1/i.test(s)) {
    return { rows: [{ c: db.leads.filter(l => l.owner_id === params[0]).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM appointments WHERE owner_id = \$1/i.test(s)) {
    return { rows: [{ c: db.appointments.filter(a => a.owner_id === params[0]).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM deals WHERE lower\(assigned_rep\) = \$1/i.test(s)) {
    return { rows: [{ c: db.deals.filter(d => (d.assigned_rep || '').toLowerCase() === params[0]).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM tasks WHERE lower\(assigned_to\) = \$1/i.test(s)) {
    return { rows: [{ c: db.tasks.filter(t => (t.assigned_to || '').toLowerCase() === params[0]).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM deal_commissions WHERE lower\(recipient_name\) = \$1/i.test(s)) {
    return { rows: [{ c: db.deal_commissions.filter(c2 => (c2.recipient_name || '').toLowerCase() === params[0]).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM lead_submissions WHERE lower\(assigned_rep_at_time\) = lower\(\$1\)/i.test(s) || /^SELECT COUNT\(\*\)::int c FROM lead_submissions WHERE lower\(assigned_rep_at_time\) = \$1/i.test(s)) {
    return { rows: [{ c: db.lead_submissions.filter(x => (x.assigned_rep_at_time || '').toLowerCase() === String(params[0]).toLowerCase()).length }] };
  }
  if (/^SELECT COUNT\(\*\)::int c FROM appointment_events WHERE lower\(actor\) = lower\(\$1\)/i.test(s) || /^SELECT COUNT\(\*\)::int c FROM appointment_events WHERE lower\(actor\) = \$1/i.test(s)) {
    return { rows: [{ c: db.appointment_events.filter(x => (x.actor || '').toLowerCase() === String(params[0]).toLowerCase()).length }] };
  }

  // Overlap check (both preview and merge use the same shape: $1=keep, $2=merge)
  if (/JOIN appointments m ON m\.owner_id = \$1/i.test(s) && /WHERE s\.owner_id = \$2/i.test(s)) {
    const keepId = params[0], mergeId = params[1];
    const keepAppts = db.appointments.filter(a => a.owner_id === keepId && ['scheduled', 'confirmed'].includes(a.status));
    const mergeAppts = db.appointments.filter(a => a.owner_id === mergeId && ['scheduled', 'confirmed'].includes(a.status));
    const conflicts = [];
    for (const s2 of mergeAppts) for (const m of keepAppts) if (overlaps(s2, m)) conflicts.push({ merge_appt_id: s2.id, keep_appt_id: m.id, start_at: s2.start, end_at: s2.end });
    return { rows: conflicts };
  }

  // Merge mutations
  if (/^SELECT \* FROM owners WHERE id IN \(\$1, \$2\) FOR UPDATE/i.test(s)) {
    return { rows: db.owners.filter(o => params.includes(o.id)) };
  }
  if (/^UPDATE leads SET owner_id = \$1, updated_at = NOW\(\) WHERE owner_id = \$2/i.test(s)) {
    const rows = db.leads.filter(l => l.owner_id === params[1]);
    rows.forEach(l => { l.owner_id = params[0]; });
    return { rowCount: rows.length };
  }
  if (/^UPDATE appointments SET owner_id = \$1, updated_at = NOW\(\) WHERE owner_id = \$2/i.test(s)) {
    const rows = db.appointments.filter(a => a.owner_id === params[1]);
    rows.forEach(a => { a.owner_id = params[0]; });
    return { rowCount: rows.length };
  }
  if (/^UPDATE deals SET assigned_rep = \$1, updated_at = NOW\(\) WHERE lower\(assigned_rep\) = lower\(\$2\)/i.test(s)) {
    const rows = db.deals.filter(d => (d.assigned_rep || '').toLowerCase() === String(params[1]).toLowerCase());
    rows.forEach(d => { d.assigned_rep = params[0]; });
    return { rowCount: rows.length };
  }
  if (/^UPDATE tasks SET assigned_to = \$1 WHERE lower\(assigned_to\) = lower\(\$2\)/i.test(s)) {
    const rows = db.tasks.filter(t => (t.assigned_to || '').toLowerCase() === String(params[1]).toLowerCase());
    rows.forEach(t => { t.assigned_to = params[0]; });
    return { rowCount: rows.length };
  }
  if (/^UPDATE deal_commissions SET recipient_name = \$1, updated_at = NOW\(\) WHERE lower\(recipient_name\) = lower\(\$2\)/i.test(s)) {
    const rows = db.deal_commissions.filter(c2 => (c2.recipient_name || '').toLowerCase() === String(params[1]).toLowerCase());
    rows.forEach(c2 => { c2.recipient_name = params[0]; });
    return { rowCount: rows.length };
  }
  if (/^UPDATE owners SET is_active = false, merged_into_owner_id = \$1, merged_at = NOW\(\) WHERE id = \$2/i.test(s)) {
    const o = db.owners.find(x => x.id === params[1]);
    if (o) { o.is_active = false; o.merged_into_owner_id = params[0]; o.merged_at = new Date().toISOString(); }
    return { rowCount: o ? 1 : 0 };
  }

  throw new Error('mockQuery: unrecognized query: ' + s);
}

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: mockQuery,
    pool: { connect: async () => ({ query: mockQuery, release: () => {} }) },
  },
};

delete require.cache[require.resolve('../routes/owners')];
const ownersRouter = require('../routes/owners');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/owners', ownersRouter);
    const server = app.listen(0, () => resolve(server));
  });
}
function req(server, method, pathStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ port, path: pathStr, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => {
        let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ADMIN = { Authorization: 'Bearer admin' };
const NONADMIN = { Authorization: 'Bearer nonadmin' };

test('GET /all: 403 for non-admin', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners/all', { headers: NONADMIN });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('GET /all: admin sees every owner (active + inactive) with reference counts — the read-only audit', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners/all', { headers: ADMIN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 3);
    const legacy = r.body.items.find(o => o.id === 'yaron-legacy');
    assert.strictEqual(legacy.reference_counts.leads, 2);
    assert.strictEqual(legacy.reference_counts.appointments, 1);
    assert.strictEqual(legacy.reference_counts.deals, 1, 'deals matched by display_name, shared with canonical');
    assert.strictEqual(legacy.reference_counts.total, 2 + 1 + 1 + 1 + 1);
  } finally { s.close(); }
});

test('merge-preview: 403 for non-admin', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners/yaron-legacy/merge-preview?keep_id=yaron-canonical', { headers: NONADMIN });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('merge-preview: shows exactly what will be repointed, without mutating anything', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners/yaron-legacy/merge-preview?keep_id=yaron-canonical', { headers: ADMIN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.will_repoint.leads, 2);
    assert.strictEqual(r.body.will_repoint.appointments, 1);
    assert.strictEqual(r.body.will_repoint.deals, 1);
    assert.strictEqual(r.body.preserved_historical.lead_submissions, 1);
    assert.strictEqual(r.body.preserved_historical.appointment_events, 1);
    assert.strictEqual(r.body.blocked, false);
    // Nothing mutated:
    assert.strictEqual(db.leads.filter(l => l.owner_id === 'yaron-legacy').length, 2);
    assert.strictEqual(db.owners.find(o => o.id === 'yaron-legacy').is_active, true);
  } finally { s.close(); }
});

test('merge-preview: rejects self-merge', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners/yaron-legacy/merge-preview?keep_id=yaron-legacy', { headers: ADMIN });
    assert.strictEqual(r.status, 400);
  } finally { s.close(); }
});

test('POST /merge: 403 for non-admin, no mutation', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: NONADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(db.owners.find(o => o.id === 'yaron-legacy').is_active, true);
  } finally { s.close(); }
});

test('POST /merge: rejects self-merge', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-legacy', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 400);
  } finally { s.close(); }
});

test('POST /merge: THE FULL CONSOLIDATION — repoints every live reference, preserves historical text, deactivates the duplicate, leaves exactly one active Yaron', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.stats.leads, 2);
    assert.strictEqual(r.body.stats.appointments, 1);
    // Both Yaron rows already share the identical display_name "Yaron
    // Drilevich" (the actual production case — only the email differs), so
    // the TEXT columns (deals.assigned_rep etc.) need no UPDATE at all —
    // they already read correctly. stats.deals/tasks/deal_commissions are
    // legitimately 0 here; the separate test below proves the TEXT-repoint
    // logic itself works when the display names genuinely differ.
    assert.strictEqual(r.body.stats.deals, 0);
    assert.strictEqual(r.body.stats.tasks, 0);
    assert.strictEqual(r.body.stats.deal_commissions, 0);
    assert.strictEqual(r.body.preserved.lead_submissions, 1);
    assert.strictEqual(r.body.preserved.appointment_events, 1);

    // Live references repointed:
    assert.ok(db.leads.every(l => l.owner_id === 'yaron-canonical'));
    assert.ok(db.appointments.every(a => a.owner_id === 'yaron-canonical'));
    assert.strictEqual(db.deals[0].assigned_rep, 'Yaron Drilevich'); // same display name, but now unambiguously one owner backs it

    // Historical/audit text UNTOUCHED (never repointed — would falsify history):
    assert.strictEqual(db.lead_submissions[0].assigned_rep_at_time, 'Yaron Drilevich');
    assert.strictEqual(db.appointment_events[0].actor, 'Yaron Drilevich');

    // Duplicate deactivated, never deleted, tagged with where it went:
    const legacy = db.owners.find(o => o.id === 'yaron-legacy');
    assert.strictEqual(legacy.is_active, false);
    assert.strictEqual(legacy.merged_into_owner_id, 'yaron-canonical');
    assert.ok(legacy.merged_at);

    // Exactly one active Yaron remains, with the canonical email:
    const activeYarons = db.owners.filter(o => o.is_active && o.display_name === 'Yaron Drilevich');
    assert.strictEqual(activeYarons.length, 1);
    assert.strictEqual(activeYarons[0].email, 'yaron@ecconstructiongroup.com');

    // Michelle untouched:
    assert.ok(db.owners.find(o => o.id === 'michelle' && o.is_active));
  } finally { s.close(); }
});

test('POST /merge: when the duplicate\'s display_name genuinely differs from canonical, TEXT columns (deals.assigned_rep, tasks.assigned_to, deal_commissions.recipient_name) are actually rewritten — the generalized equivalent of the retired one-off Shlomi→Simon merge script', async () => {
  reset();
  db.owners.push({ id: 'renamed-owner', email: 'renamed@ecconstructiongroup.com', display_name: 'Old Name Rep', is_active: true, merged_into_owner_id: null, merged_at: null, created_at: '2020-01-01T00:00:00Z' });
  db.deals.push({ id: 'deal-2', assigned_rep: 'Old Name Rep' });
  db.tasks.push({ id: 'task-2', assigned_to: 'Old Name Rep' });
  db.deal_commissions.push({ id: 'comm-2', recipient_name: 'Old Name Rep' });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'renamed-owner' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.stats.deals, 1);
    assert.strictEqual(r.body.stats.tasks, 1);
    assert.strictEqual(r.body.stats.deal_commissions, 1);
    assert.strictEqual(db.deals.find(d => d.id === 'deal-2').assigned_rep, 'Yaron Drilevich');
    assert.strictEqual(db.tasks.find(t => t.id === 'task-2').assigned_to, 'Yaron Drilevich');
    assert.strictEqual(db.deal_commissions.find(c => c.id === 'comm-2').recipient_name, 'Yaron Drilevich');
  } finally { s.close(); }
});

test('POST /merge: appointment overlap collision is blocked (fails closed), nothing mutated', async () => {
  reset();
  // Give the canonical owner an overlapping active appointment.
  db.appointments.push({ id: 'appt-2', owner_id: 'yaron-canonical', status: 'confirmed', start: 150, end: 250 });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 409);
    assert.ok(r.body.conflicts.length >= 1);
    // ROLLBACK must have undone everything, including the deactivation:
    assert.strictEqual(db.owners.find(o => o.id === 'yaron-legacy').is_active, true);
    assert.ok(db.leads.some(l => l.owner_id === 'yaron-legacy'), 'leads must not be repointed when the merge is aborted');
  } finally { s.close(); }
});

test('POST /merge: idempotent — merging the same pair again is a safe no-op, not an error', async () => {
  reset();
  const s1 = await startServer();
  await req(s1, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'yaron-legacy' } });
  s1.close();

  const s2 = await startServer();
  try {
    const r = await req(s2, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.already_merged, true);
  } finally { s2.close(); }
});

test('POST /merge: merging an already-merged owner toward a DIFFERENT target is rejected, not chained', async () => {
  reset();
  db.owners.find(o => o.id === 'yaron-legacy').is_active = false;
  db.owners.find(o => o.id === 'yaron-legacy').merged_into_owner_id = 'yaron-canonical';
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'michelle', merge_id: 'yaron-legacy' } });
    assert.strictEqual(r.status, 409);
  } finally { s.close(); }
});

test('POST /merge: using an already-merged owner AS THE KEEP target is rejected', async () => {
  reset();
  db.owners.find(o => o.id === 'yaron-legacy').is_active = false;
  db.owners.find(o => o.id === 'yaron-legacy').merged_into_owner_id = 'yaron-canonical';
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-legacy', merge_id: 'michelle' } });
    assert.strictEqual(r.status, 409);
  } finally { s.close(); }
});

test('POST /merge: 404 when one owner does not exist', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/owners/merge', { headers: ADMIN, body: { keep_id: 'yaron-canonical', merge_id: 'does-not-exist' } });
    assert.strictEqual(r.status, 404);
  } finally { s.close(); }
});

test('this route never reads or writes the users/authentication table', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/owners'), 'utf8');
  assert.ok(!/FROM users|UPDATE users|INSERT INTO users/i.test(src));
});
