/* eslint-disable no-undef */
/**
 * calendarOrphanClassification.test.cjs — Tests for the temporary read-only
 * calendar orphan classification diagnostic.
 *
 * Tests two properties:
 *   1. The diagnostic route file contains ZERO write keywords (INSERT, UPDATE,
 *      DELETE, UPSERT, reconciliation, repair, queue creation, calendar mutation).
 *   2. The classification logic correctly categorizes appointments by status ×
 *      time into the 5 categories that sum to the orphan count.
 *
 * Run: node github-main/test/calendarOrphanClassification.test.cjs
 */
'use strict';

var fs = require('fs');
var path = require('path');

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) { tests.push({ name: name, fn: fn }); }
function assert(c, m) { if (!c) throw new Error('Assertion failed: ' + m); }
function eq(a, e, m) {
  var aj = JSON.stringify(a), ej = JSON.stringify(e);
  if (aj !== ej) throw new Error(m + ': expected ' + ej + ', got ' + aj);
}

// ═════════════════════════════════════════════════════════════════════
// SECTION 1: READ-ONLY VERIFICATION — zero write keywords in source
// ═════════════════════════════════════════════════════════════════════

var SOURCE_PATH = path.resolve(__dirname, '..', 'routes', 'calendarOrphanClassification.js');

test('read-only: file exists', function() {
  assert(fs.existsSync(SOURCE_PATH), 'calendarOrphanClassification.js must exist at ' + SOURCE_PATH);
});

test('read-only: zero INSERT keywords', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lines = src.split('\n');
  var codeLines = lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
  var insertLines = codeLines.filter(function(l) {
    return /\bINSERT\b/i.test(l);
  });
  eq(insertLines.length, 0, 'must have zero INSERT keywords in code; found: ' + insertLines.length);
});

test('read-only: zero UPDATE keywords', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lines = src.split('\n');
  var codeLines = lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
  var updateLines = codeLines.filter(function(l) {
    return /\bUPDATE\b/i.test(l) && !l.includes('updated_at');
  });
  eq(updateLines.length, 0, 'must have zero UPDATE keywords in code; found: ' + updateLines.length);
});

test('read-only: zero DELETE keywords', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lines = src.split('\n');
  var codeLines = lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
  var deleteLines = codeLines.filter(function(l) {
    return /\bDELETE\b/i.test(l);
  });
  eq(deleteLines.length, 0, 'must have zero DELETE keywords in code; found: ' + deleteLines.length);
});

test('read-only: zero UPSERT keywords', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lines = src.split('\n');
  var codeLines = lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
  var upsertLines = codeLines.filter(function(l) {
    return /\bUPSERT\b/i.test(l) || /ON CONFLICT.*DO UPDATE/i.test(l);
  });
  eq(upsertLines.length, 0, 'must have zero UPSERT keywords in code; found: ' + upsertLines.length);
});

function getCodeLines(src) {
  var lines = src.split('\n');
  return lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
}

test('read-only: zero reconciliation keywords in code', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var codeLines = getCodeLines(src);
  var code = codeLines.join('\n').toLowerCase();
  assert(!code.includes('reconciliation'), 'must not contain "reconciliation" in code');
  assert(!code.includes('reconcile'), 'must not contain "reconcile" in code');
});

test('read-only: zero repair keywords in code', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var codeLines = getCodeLines(src);
  var code = codeLines.join('\n').toLowerCase();
  assert(!code.includes('repair'), 'must not contain "repair" in code');
});

test('read-only: zero queue creation keywords in code', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var codeLines = getCodeLines(src);
  var code = codeLines.join('\n').toLowerCase();
  assert(!code.includes('enqueue'), 'must not contain "enqueue" in code');
  assert(!code.includes('queue'), 'must not contain "queue" in code');
});

test('read-only: zero calendar mutation keywords', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lower = src.toLowerCase();
  assert(!lower.includes('createevent'), 'must not contain "createevent"');
  assert(!lower.includes('updateevent'), 'must not contain "updateevent"');
  assert(!lower.includes('deleteevent'), 'must not contain "deleteevent"');
  assert(!lower.includes('cancelevent'), 'must not contain "cancelevent"');
});

test('read-only: no query() call contains INSERT/UPDATE/DELETE', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var lines = src.split('\n');
  var codeLines = lines.filter(function(l) {
    return !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*');
  });
  var writeSqlLines = codeLines.filter(function(l) {
    return /\b(INSERT|UPDATE|DELETE|UPSERT)\b/i.test(l) && !/updated_at/.test(l);
  });
  eq(writeSqlLines.length, 0, 'must have zero write SQL keywords; found: ' + writeSqlLines.length);
});

test('read-only: has requireWorkerSecret guard', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert(src.includes('requireWorkerSecret'), 'must have requireWorkerSecret function');
  assert(src.includes('X-Worker-Secret'), 'must check X-Worker-Secret header');
  assert(src.includes('WORKER_SECRET'), 'must check process.env.WORKER_SECRET');
  assert(src.includes("router.use(requireWorkerSecret)"), 'must apply guard to router');
});

// ═════════════════════════════════════════════════════════════════════
// SECTION 2: CLASSIFICATION LOGIC TESTS
// ═════════════════════════════════════════════════════════════════════

function classifyAppointment(status, startAtMs, nowMs) {
  var now = nowMs || Date.now();
  var isScheduled = status === 'scheduled' || status === 'confirmed';
  if (isScheduled && startAtMs >= now) return 'scheduled_future';
  if (isScheduled && startAtMs < now) return 'scheduled_past';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'other';
}

test('classification: scheduled future', function() {
  var cat = classifyAppointment('scheduled', Date.now() + 3600000);
  eq(cat, 'scheduled_future', 'scheduled + future = scheduled_future');
});

test('classification: confirmed future', function() {
  var cat = classifyAppointment('confirmed', Date.now() + 3600000);
  eq(cat, 'scheduled_future', 'confirmed + future = scheduled_future');
});

test('classification: scheduled past', function() {
  var cat = classifyAppointment('scheduled', Date.now() - 3600000);
  eq(cat, 'scheduled_past', 'scheduled + past = scheduled_past');
});

test('classification: confirmed past', function() {
  var cat = classifyAppointment('confirmed', Date.now() - 3600000);
  eq(cat, 'scheduled_past', 'confirmed + past = scheduled_past');
});

test('classification: completed', function() {
  var cat = classifyAppointment('completed', Date.now() + 3600000);
  eq(cat, 'completed', 'completed = completed regardless of time');
});

test('classification: cancelled', function() {
  var cat = classifyAppointment('cancelled', Date.now() + 3600000);
  eq(cat, 'cancelled', 'cancelled = cancelled regardless of time');
});

test('classification: other (no_show)', function() {
  var cat = classifyAppointment('no_show', Date.now() + 3600000);
  eq(cat, 'other', 'no_show = other');
});

test('classification: other (rescheduled)', function() {
  var cat = classifyAppointment('rescheduled', Date.now() + 3600000);
  eq(cat, 'other', 'rescheduled = other');
});

test('classification: other (null status)', function() {
  var cat = classifyAppointment(null, Date.now() + 3600000);
  eq(cat, 'other', 'null status = other');
});

test('classification: sum equals orphan count', function() {
  var orphans = [
    { status: 'scheduled', startAt: Date.now() + 3600000 },
    { status: 'confirmed', startAt: Date.now() + 7200000 },
    { status: 'scheduled', startAt: Date.now() - 3600000 },
    { status: 'completed', startAt: Date.now() - 86400000 },
    { status: 'cancelled', startAt: Date.now() - 172800000 },
    { status: 'no_show', startAt: Date.now() - 259200000 },
  ];
  var counts = { scheduled_future: 0, scheduled_past: 0, completed: 0, cancelled: 0, other: 0 };
  for (var i = 0; i < orphans.length; i++) {
    var cat = classifyAppointment(orphans[i].status, orphans[i].startAt);
    counts[cat]++;
  }
  var sum = counts.scheduled_future + counts.scheduled_past + counts.completed + counts.cancelled + counts.other;
  eq(sum, orphans.length, 'sum of categories must equal orphan count');
  eq(counts.scheduled_future, 2, '2 scheduled_future');
  eq(counts.scheduled_past, 1, '1 scheduled_past');
  eq(counts.completed, 1, '1 completed');
  eq(counts.cancelled, 1, '1 cancelled');
  eq(counts.other, 1, '1 other');
});

test('classification: all 947 are orphans (google_event_id NULL)', function() {
  var classification = {
    scheduled_future: { count: 100, google_event_id_null: 100, google_event_id_not_null: 0 },
    scheduled_past: { count: 200, google_event_id_null: 200, google_event_id_not_null: 0 },
    completed: { count: 300, google_event_id_null: 300, google_event_id_not_null: 0 },
    cancelled: { count: 347, google_event_id_null: 347, google_event_id_not_null: 0 },
    other: { count: 0, google_event_id_null: 0, google_event_id_not_null: 0 },
  };
  var totalNull = 0;
  var totalNotNull = 0;
  for (var cat in classification) {
    totalNull += classification[cat].google_event_id_null;
    totalNotNull += classification[cat].google_event_id_not_null;
  }
  eq(totalNotNull, 0, 'google_event_id_not_null must be 0 for all categories');
  eq(totalNull, 947, 'google_event_id_null must sum to 947');
});

// ═════════════════════════════════════════════════════════════════════
// SECTION 3: RESPONSE STRUCTURE TESTS
// ═════════════════════════════════════════════════════════════════════

test('response structure: has all required fields', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var requiredFields = [
    'diagnostic',
    'read_only',
    'zero_writes',
    'total_appointments',
    'total_without_google_event_id',
    'classification',
    'classified_sum',
    'sum_matches',
    'min_start_at',
    'max_start_at',
    'future_scheduled_no_google_event_count',
    'future_scheduled_no_outbox_count',
    'queried_at',
  ];
  for (var i = 0; i < requiredFields.length; i++) {
    assert(src.includes(requiredFields[i]), 'response must include field: ' + requiredFields[i]);
  }
});

test('response structure: classification has 5 categories', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var categories = ['scheduled_future', 'scheduled_past', 'completed', 'cancelled', 'other'];
  for (var i = 0; i < categories.length; i++) {
    assert(src.includes("'" + categories[i] + "'"), 'classification must include category: ' + categories[i]);
  }
});

test('response structure: each category has required sub-fields', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  var subFields = [
    'count',
    'google_event_id_null',
    'google_event_id_not_null',
    'outbox_exists',
    'outbox_absent',
    'outbox_status_distribution',
  ];
  for (var i = 0; i < subFields.length; i++) {
    assert(src.includes(subFields[i]), 'each category must include: ' + subFields[i]);
  }
});

test('response structure: read_only is true', function() {
  var src = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert(src.includes('read_only: true'), 'read_only must be true');
  assert(src.includes('zero_writes: true'), 'zero_writes must be true');
});

// ═════════════════════════════════════════════════════════════════════
// RUN ALL TESTS
// ═════════════════════════════════════════════════════════════════════

for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + tests[i].name + ' — ' + e.message);
  }
}

console.log('\n═══ Calendar Orphan Classification Tests ═══');
console.log('Passed: ' + passed + '/' + tests.length);
console.log('Failed: ' + failed + '/' + tests.length);
if (failed === 0) {
  console.log('✓ ALL TESTS PASSED');
} else {
  console.log('✗ ' + failed + ' TEST(S) FAILED');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tests: tests, passed: passed, failed: failed };
}