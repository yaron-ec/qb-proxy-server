/* eslint-disable no-undef */
/**
 * handoffClient.test.js — Unit tests for the Handoff REST client.
 *
 * Tests all pure functions (normalization, matching, error classification)
 * that do NOT require the live API key or database connection.
 *
 * Run in proxy-server environment: node test/handoffClient.test.js
 * Run in Base44 sandbox: tested via exec_tool (pure functions only).
 */
'use strict';

// We test the pure functions directly by requiring them from the client.
// In the Base44 sandbox, we can't require the full module (it depends on
// ../db/client), so we test the pure logic inline with the same implementation.

// ── Inline copies of pure functions for sandbox testing ──────────────────
// These are identical to the exported functions in handoffClient.js.

function extractArray(rawResponse) {
  if (Array.isArray(rawResponse)) return rawResponse;
  if (rawResponse && typeof rawResponse === 'object') {
    if (Array.isArray(rawResponse.data)) return rawResponse.data;
    if (Array.isArray(rawResponse.items)) return rawResponse.items;
    if (Array.isArray(rawResponse.results)) return rawResponse.results;
    if (Array.isArray(rawResponse.estimates)) return rawResponse.estimates;
    if (Array.isArray(rawResponse.projects)) return rawResponse.projects;
    if (Array.isArray(rawResponse.contacts)) return rawResponse.contacts;
    if (rawResponse.id || rawResponse._id) return [rawResponse];
  }
  return [];
}

function extractCursor(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') return null;
  return rawResponse.nextCursor || rawResponse.cursor || rawResponse.nextPageToken ||
    (rawResponse.pagination && rawResponse.pagination.cursor) || null;
}

function normalizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var contact = raw.contact || raw.customer || raw.client || {};
  var proposal = raw.proposal || raw.document || {};
  var total = 0;
  if (raw.totalUsdCents != null) total = raw.totalUsdCents / 100;
  else if (raw.totalCents != null) total = raw.totalCents / 100;
  else if (raw.total != null) total = Number(raw.total);
  else if (raw.amount != null) total = Number(raw.amount);
  return {
    id: String(raw.id || raw._id || raw.estimateId || raw.estimate_id || ''),
    name: raw.name || raw.title || raw.estimateName || raw.estimate_number || '',
    state: raw.state || raw.status || '',
    total: total,
    createdAt: raw.createdAt || raw.created_at || raw.date || null,
    clientName: contact.name || raw.customerName || raw.clientName || raw.customer_name || '',
    clientPhone: contact.phoneNumber || contact.phone || raw.customerPhone || raw.customer_phone || '',
    clientEmail: contact.email || raw.customerEmail || raw.customer_email || '',
    proposalLink: proposal.publicLink || proposal.url || raw.proposalLink || raw.document_url || null,
    lineItems: raw.lineItems || raw.line_items || raw.items || null,
    projectId: raw.projectId || raw.project_id || (raw.project && raw.project.id) || null,
    projectName: raw.projectName || (raw.project && raw.project.name) || (raw.project && raw.project.number) || null,
  };
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var contact = raw.contact || raw.customer || raw.client || {};
  return {
    id: String(raw.id || raw._id || raw.projectId || raw.project_id || ''),
    number: raw.number || raw.projectNumber || raw.project_number || '',
    name: raw.name || raw.title || raw.projectName || '',
    state: raw.state || raw.status || '',
    createdAt: raw.createdAt || raw.created_at || raw.date || null,
    clientName: contact.name || raw.customerName || raw.clientName || '',
    clientPhone: contact.phoneNumber || contact.phone || raw.customerPhone || '',
    clientEmail: contact.email || raw.customerEmail || '',
    address: raw.address || raw.propertyAddress || raw.property_address || raw.location || '',
  };
}

function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id || raw._id || raw.contactId || raw.contact_id || ''),
    name: raw.name || raw.fullName || raw.full_name || '',
    email: raw.email || '',
    phone: raw.phone || raw.phoneNumber || raw.phone_number || '',
    address: raw.address || raw.propertyAddress || raw.property_address || '',
    createdAt: raw.createdAt || raw.created_at || null,
  };
}

var normPhone = function (p) { return (p || '').replace(/\D/g, '').slice(-10); };
var normEmail = function (e) { return (e || '').toLowerCase().trim(); };
var normName = function (n) { return (n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z\s]/g, ''); };

function matchEstimateToLead(est, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));
  var estPhone = normPhone(est.clientPhone || '');
  var estEmail = normEmail(est.clientEmail || '');
  var estName = normName(est.clientName || '');
  if (estPhone && leadPhone && estPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (estEmail && leadEmail && estEmail === leadEmail) return { match: true, method: 'name_email' };
  if (estName && leadName && estName === leadName) return { match: true, method: 'name_exact' };
  if (estName && leadName) {
    var ep = estName.split(' '), lp = leadName.split(' ');
    if (ep.length >= 2 && lp.length >= 2 && ep[0] === lp[0] && ep[ep.length - 1] === lp[lp.length - 1]) {
      return { match: true, method: 'name_parts' };
    }
    if (ep[ep.length - 1] && ep[ep.length - 1] === lp[lp.length - 1] && ep[ep.length - 1].length > 2) {
      return { match: true, method: 'name_last' };
    }
  }
  return { match: false, method: 'none' };
}

function matchProjectToLead(proj, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));
  var leadAddress = (lead.property_address || '').toLowerCase().trim();
  var projPhone = normPhone(proj.clientPhone || '');
  var projEmail = normEmail(proj.clientEmail || '');
  var projName = normName(proj.clientName || '');
  var projAddress = (proj.address || '').toLowerCase().trim();
  if (projPhone && leadPhone && projPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (projEmail && leadEmail && projEmail === leadEmail) return { match: true, method: 'name_email' };
  if (projName && leadName && projName === leadName) return { match: true, method: 'name_exact' };
  if (projAddress && leadAddress && (projAddress.indexOf(leadAddress) >= 0 || leadAddress.indexOf(projAddress) >= 0)) {
    return { match: true, method: 'address' };
  }
  return { match: false, method: 'none' };
}

function matchContactToLead(contact, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));
  var cPhone = normPhone(contact.phone || '');
  var cEmail = normEmail(contact.email || '');
  var cName = normName(contact.name || '');
  if (cPhone && leadPhone && cPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (cEmail && leadEmail && cEmail === leadEmail) return { match: true, method: 'name_email' };
  if (cName && leadName && cName === leadName) return { match: true, method: 'name_exact' };
  return { match: false, method: 'none' };
}

// ── Test runner ─────────────────────────────────────────────────────────

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

function assertEqual(actual, expected, message) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) throw new Error(message + ': expected ' + e + ', got ' + a);
}

// ── Tests: extractArray ──────────────────────────────────────────────────

test('extractArray: bare array', function () {
  var result = extractArray([1, 2, 3]);
  assertEqual(result, [1, 2, 3], 'should return bare array');
});

test('extractArray: { data: [...] }', function () {
  var result = extractArray({ data: [1, 2, 3] });
  assertEqual(result, [1, 2, 3], 'should extract data array');
});

test('extractArray: { items: [...] }', function () {
  var result = extractArray({ items: [1, 2, 3] });
  assertEqual(result, [1, 2, 3], 'should extract items array');
});

test('extractArray: { estimates: [...] }', function () {
  var result = extractArray({ estimates: [{ id: 'e1' }] });
  assertEqual(result.length, 1, 'should extract estimates array');
});

test('extractArray: { projects: [...] }', function () {
  var result = extractArray({ projects: [{ id: 'p1' }] });
  assertEqual(result.length, 1, 'should extract projects array');
});

test('extractArray: { contacts: [...] }', function () {
  var result = extractArray({ contacts: [{ id: 'c1' }] });
  assertEqual(result.length, 1, 'should extract contacts array');
});

test('extractArray: single object with id', function () {
  var result = extractArray({ id: 'e1', name: 'Test' });
  assertEqual(result.length, 1, 'should wrap single object in array');
  assertEqual(result[0].id, 'e1', 'should preserve id');
});

test('extractArray: null/undefined', function () {
  assertEqual(extractArray(null), [], 'should return empty array for null');
  assertEqual(extractArray(undefined), [], 'should return empty array for undefined');
  assertEqual(extractArray({}), [], 'should return empty array for empty object');
});

// ── Tests: extractCursor ─────────────────────────────────────────────────

test('extractCursor: nextCursor', function () {
  assertEqual(extractCursor({ nextCursor: 'abc' }), 'abc', 'should extract nextCursor');
});

test('extractCursor: cursor', function () {
  assertEqual(extractCursor({ cursor: 'def' }), 'def', 'should extract cursor');
});

test('extractCursor: pagination.cursor', function () {
  assertEqual(extractCursor({ pagination: { cursor: 'ghi' } }), 'ghi', 'should extract nested cursor');
});

test('extractCursor: null when no cursor', function () {
  assertEqual(extractCursor({ data: [] }), null, 'should return null when no cursor');
  assertEqual(extractCursor(null), null, 'should return null for null input');
});

// ── Tests: normalizeEstimate ─────────────────────────────────────────────

test('normalizeEstimate: full nested object', function () {
  var raw = {
    id: 'est_123',
    name: 'Kitchen Remodel',
    state: 'SENT',
    totalUsdCents: 450000,
    createdAt: '2026-09-01T10:00:00Z',
    contact: { name: 'John Doe', email: 'john@test.com', phoneNumber: '+13105551234' },
    proposal: { publicLink: 'https://handoff.ai/p/abc' },
    lineItems: [{ description: 'Cabinets', total: 200000 }],
  };
  var result = normalizeEstimate(raw);
  assertEqual(result.id, 'est_123', 'id');
  assertEqual(result.name, 'Kitchen Remodel', 'name');
  assertEqual(result.state, 'SENT', 'state');
  assertEqual(result.total, 4500, 'total (cents to dollars)');
  assertEqual(result.clientName, 'John Doe', 'clientName from nested contact');
  assertEqual(result.clientPhone, '+13105551234', 'clientPhone from nested contact');
  assertEqual(result.clientEmail, 'john@test.com', 'clientEmail from nested contact');
  assertEqual(result.proposalLink, 'https://handoff.ai/p/abc', 'proposalLink from nested proposal');
  assertEqual(result.lineItems.length, 1, 'lineItems preserved');
});

test('normalizeEstimate: flat object with alternate field names', function () {
  var raw = {
    _id: 'abc',
    title: 'Bathroom',
    status: 'DRAFT',
    total: 5000,
    customerName: 'Jane Smith',
    customer_phone: '310-555-9999',
    customer_email: 'jane@test.com',
    document_url: 'https://example.com/doc',
  };
  var result = normalizeEstimate(raw);
  assertEqual(result.id, 'abc', 'id from _id');
  assertEqual(result.name, 'Bathroom', 'name from title');
  assertEqual(result.state, 'DRAFT', 'state from status');
  assertEqual(result.total, 5000, 'total from total field');
  assertEqual(result.clientName, 'Jane Smith', 'clientName from customerName');
  assertEqual(result.clientPhone, '310-555-9999', 'clientPhone from customer_phone');
  assertEqual(result.clientEmail, 'jane@test.com', 'clientEmail from customer_email');
  assertEqual(result.proposalLink, 'https://example.com/doc', 'proposalLink from document_url');
});

test('normalizeEstimate: null/invalid input', function () {
  assertEqual(normalizeEstimate(null), null, 'should return null for null');
  assertEqual(normalizeEstimate(undefined), null, 'should return null for undefined');
  assertEqual(normalizeEstimate('string'), null, 'should return null for string');
});

test('normalizeEstimate: totalCents variant', function () {
  assertEqual(normalizeEstimate({ id: '1', totalCents: 12345 }).total, 123.45, 'totalCents to dollars');
  assertEqual(normalizeEstimate({ id: '1', amount: 100 }).total, 100, 'amount field');
  assertEqual(normalizeEstimate({ id: '1' }).total, 0, 'default 0');
});

// ── Tests: normalizeProject ───────────────────────────────────────────────

test('normalizeProject: full object', function () {
  var raw = {
    id: 'prj_456',
    number: 'PRJ-10198',
    name: 'Smith Residence',
    state: 'ACTIVE',
    contact: { name: 'Bob Smith', phone: '310-555-0000', email: 'bob@test.com' },
    address: '123 Main St, Los Angeles, CA',
  };
  var result = normalizeProject(raw);
  assertEqual(result.id, 'prj_456', 'id');
  assertEqual(result.number, 'PRJ-10198', 'number');
  assertEqual(result.name, 'Smith Residence', 'name');
  assertEqual(result.clientName, 'Bob Smith', 'clientName');
  assertEqual(result.address, '123 Main St, Los Angeles, CA', 'address');
});

test('normalizeProject: null input', function () {
  assertEqual(normalizeProject(null), null, 'should return null for null');
});

// ── Tests: normalizeContact ──────────────────────────────────────────────

test('normalizeContact: full object', function () {
  var raw = {
    id: 'ct_789',
    name: 'Alice Jones',
    email: 'alice@test.com',
    phone: '+13105551111',
    address: '456 Oak Ave',
  };
  var result = normalizeContact(raw);
  assertEqual(result.id, 'ct_789', 'id');
  assertEqual(result.name, 'Alice Jones', 'name');
  assertEqual(result.email, 'alice@test.com', 'email');
  assertEqual(result.phone, '+13105551111', 'phone');
  assertEqual(result.address, '456 Oak Ave', 'address');
});

// ── Tests: matchEstimateToLead ───────────────────────────────────────────

test('matchEstimateToLead: phone match', function () {
  var est = { clientPhone: '+13105551234', clientEmail: '', clientName: '' };
  var lead = { phone: '310-555-1234', email: '', first_name: '', last_name: '' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match by phone');
  assertEqual(result.method, 'name_phone', 'method should be name_phone');
});

test('matchEstimateToLead: email match', function () {
  var est = { clientPhone: '', clientEmail: 'john@test.com', clientName: '' };
  var lead = { phone: '', email: 'JOHN@test.com', first_name: '', last_name: '' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match by email (case-insensitive)');
  assertEqual(result.method, 'name_email', 'method should be name_email');
});

test('matchEstimateToLead: exact name match', function () {
  var est = { clientPhone: '', clientEmail: '', clientName: 'John Doe' };
  var lead = { phone: '', email: '', first_name: 'John', last_name: 'Doe' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match by exact name');
  assertEqual(result.method, 'name_exact', 'method should be name_exact');
});

test('matchEstimateToLead: name parts match (first+last)', function () {
  var est = { clientPhone: '', clientEmail: '', clientName: 'John Michael Doe' };
  var lead = { phone: '', email: '', first_name: 'John', last_name: 'Doe' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match by first+last name parts');
  assertEqual(result.method, 'name_parts', 'method should be name_parts');
});

test('matchEstimateToLead: last name match', function () {
  var est = { clientPhone: '', clientEmail: '', clientName: 'Jane Smith' };
  var lead = { phone: '', email: '', first_name: 'Bob', last_name: 'Smith' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match by last name');
  assertEqual(result.method, 'name_last', 'method should be name_last');
});

test('matchEstimateToLead: no match', function () {
  var est = { clientPhone: '310-555-1111', clientEmail: 'a@test.com', clientName: 'Alice Wonderland' };
  var lead = { phone: '310-555-2222', email: 'b@test.com', first_name: 'Bob', last_name: 'Builder' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, false, 'should not match');
  assertEqual(result.method, 'none', 'method should be none');
});

test('matchEstimateToLead: phone with different formats', function () {
  var est = { clientPhone: '+1 (310) 555-1234', clientName: '' };
  var lead = { phone: '3105551234', first_name: '', last_name: '' };
  var result = matchEstimateToLead(est, lead);
  assertEqual(result.match, true, 'should match phone with different formats');
});

// ── Tests: matchProjectToLead ───────────────────────────────────────────

test('matchProjectToLead: address match', function () {
  var proj = { address: '123 Main St, Los Angeles, CA 90001', clientName: '', clientPhone: '', clientEmail: '' };
  var lead = { property_address: '123 Main St', first_name: '', last_name: '', phone: '', email: '' };
  var result = matchProjectToLead(proj, lead);
  assertEqual(result.match, true, 'should match by address (partial)');
  assertEqual(result.method, 'address', 'method should be address');
});

test('matchProjectToLead: phone match', function () {
  var proj = { clientPhone: '310-555-1234', address: '', clientName: '', clientEmail: '' };
  var lead = { phone: '3105551234', property_address: '', first_name: '', last_name: '', email: '' };
  var result = matchProjectToLead(proj, lead);
  assertEqual(result.match, true, 'should match by phone');
  assertEqual(result.method, 'name_phone', 'method should be name_phone');
});

test('matchProjectToLead: no match', function () {
  var proj = { address: '999 Other St', clientPhone: '111-111-1111', clientName: 'Nobody', clientEmail: 'n@test.com' };
  var lead = { property_address: '123 Main St', phone: '222-222-2222', first_name: 'Bob', last_name: 'Builder', email: 'b@test.com' };
  var result = matchProjectToLead(proj, lead);
  assertEqual(result.match, false, 'should not match');
});

// ── Tests: matchContactToLead ───────────────────────────────────────────

test('matchContactToLead: email match', function () {
  var contact = { email: 'test@example.com', phone: '', name: '' };
  var lead = { email: 'TEST@example.com', phone: '', first_name: '', last_name: '' };
  var result = matchContactToLead(contact, lead);
  assertEqual(result.match, true, 'should match by email');
  assertEqual(result.method, 'name_email', 'method should be name_email');
});

test('matchContactToLead: no match', function () {
  var contact = { email: 'a@test.com', phone: '111', name: 'Alice' };
  var lead = { email: 'b@test.com', phone: '222', first_name: 'Bob', last_name: 'Smith' };
  var result = matchContactToLead(contact, lead);
  assertEqual(result.match, false, 'should not match');
});

// ── Run tests ────────────────────────────────────────────────────────────

for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + tests[i].name + ' — ' + e.message);
  }
}

console.log('\n═══ Handoff REST Client Tests ═══');
console.log('Passed: ' + passed + '/' + tests.length);
console.log('Failed: ' + failed + '/' + tests.length);
if (failed === 0) {
  console.log('✓ ALL TESTS PASSED');
} else {
  console.log('✗ ' + failed + ' TEST(S) FAILED');
}

module.exports = { tests: tests, passed: passed, failed: failed };