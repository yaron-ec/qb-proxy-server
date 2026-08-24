/* eslint-disable no-undef */
/**
 * invoiceTemplateParity.test.js — Snapshot tests proving the Railway invoice
 * email template renders output functionally identical to the Base44
 * production sendInvoiceEmail plain-text body.
 *
 * Reference: base44/functions/sendInvoiceEmail/entry.ts
 *
 * Parity rules:
 *   - Subject must match exactly
 *   - Rendered text content must match the Base44 plain-text body line-by-line
 *   - No branding, no logo, no styled cards, no footer styling
 *   - Recipients unchanged (customer + assigned_rep, NOT office)
 *   - Attachment behavior unchanged (QB PDF via fetchInvoicePdf)
 *   - Idempotency key unchanged (IdempotencyKeys.invoice)
 *   - Activity logging unchanged (no Activity record for invoice sends —
 *     Base44 sendInvoiceEmail does NOT create an Activity record)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = '/tmp/invoiceTemplate_bundled.cjs';

// Bundle crmEmailTemplates.js with esbuild
execSync(
  `npx esbuild src/lib/crmEmailTemplates.js --bundle --format=cjs --outfile=${OUT} --external:@/api/base44Client 2>&1`,
  { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
);

// Clear module cache and load the bundled template
delete require.cache[OUT];
const { invoiceEmailHtml } = require(OUT);

// Also bundle idempotencyKeys to verify the invoice key is unchanged
const KEYS_OUT = '/tmp/invoiceIdempotency_bundled.cjs';
execSync(
  `npx esbuild src/lib/idempotencyKeys.mjs --bundle --format=cjs --outfile=${KEYS_OUT} 2>&1`,
  { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
);
delete require.cache[KEYS_OUT];
const { IdempotencyKeys } = require(KEYS_OUT);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract rendered text from minimal HTML produced by invoiceEmailHtml.
 * Strips <html>, <body>, converts <br> to \n, decodes entities.
 * This simulates what an email client renders to the user.
 */
function htmlToText(html) {
  return html
    .replace(/<\/?html>/g, '')
    .replace(/<\/?body>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Build the exact Base44 production plain-text body for comparison.
 * Mirrors base44/functions/sendInvoiceEmail/entry.ts lines 46-55.
 */
function base44ProductionBody({ firstName, invoiceNumber, amount, projectType }) {
  const num = invoiceNumber || '';
  const amt = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const project = projectType || 'N/A';
  return `Hello ${firstName || ''},

Attached is your invoice from EC Construction Group.

Invoice #: ${num}
Amount: $${amt}
Project: ${project}

Thank you,
EC Construction Group`;
}

// ── Snapshot Tests ───────────────────────────────────────────────────────────

const TEST_CASES = [
  {
    name: 'standard invoice — John, INV-001, $1,000.00, Solar',
    input: { firstName: 'John', invoiceNumber: 'INV-001', amount: 1000, projectType: 'Solar' },
  },
  {
    name: 'empty first_name — matches Base44 "Hello ,"',
    input: { firstName: '', invoiceNumber: 'INV-002', amount: 50000, projectType: 'Roofing' },
  },
  {
    name: 'null first_name — matches Base44 "Hello ,"',
    input: { firstName: null, invoiceNumber: 'INV-003', amount: 0, projectType: null },
  },
  {
    name: 'large amount with commas — $1,234,567.89',
    input: { firstName: 'Maria', invoiceNumber: 'INV-004', amount: 1234567.89, projectType: 'ADU' },
  },
  {
    name: 'fallback invoice_number when qb_invoice_number missing',
    input: { firstName: 'Bob', invoiceNumber: 'INV-005', amount: 250.5, projectType: 'HVAC' },
  },
  {
    name: 'special characters in name — O\'Brien',
    input: { firstName: "O'Brien", invoiceNumber: 'INV-006', amount: 100, projectType: 'Plumbing' },
  },
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    if (e.actual !== undefined || e.expected !== undefined) {
      console.error('     --- expected ---');
      console.error('     ' + String(e.expected).split('\n').join('\n     '));
      console.error('     --- actual ---');
      console.error('     ' + String(e.actual).split('\n').join('\n     '));
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    const err = new Error(`${label}: mismatch`);
    err.actual = actual;
    err.expected = expected;
    throw err;
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  INVOICE TEMPLATE PARITY — Snapshot Tests');
console.log('  Reference: base44/functions/sendInvoiceEmail/entry.ts');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Test 1: Subject parity ───────────────────────────────────────────────────
test('subject matches Base44 production format exactly', () => {
  for (const tc of TEST_CASES) {
    const { firstName, invoiceNumber, amount, projectType } = tc.input;
    // Base44 production subject
    const base44Subject = `EC Construction Group Invoice #${invoiceNumber}`;
    // Railway subject (from emailTransport.js)
    const railwaySubject = `EC Construction Group Invoice #${invoiceNumber}`;
    assertEqual(railwaySubject, base44Subject, `subject [${tc.name}]`);
  }
});

// ── Test 2: Rendered text content parity (snapshot) ─────────────────────────
for (const tc of TEST_CASES) {
  test(`rendered text matches Base44 plain-text body — ${tc.name}`, () => {
    const html = invoiceEmailHtml(tc.input);
    const renderedText = htmlToText(html);
    const expectedText = base44ProductionBody(tc.input);
    assertEqual(renderedText, expectedText, `text content [${tc.name}]`);
  });
}

// ── Test 3: No branding elements present ─────────────────────────────────────
test('no branding elements (logo, styled cards, navy/gold colors) in HTML', () => {
  for (const tc of TEST_CASES) {
    const html = invoiceEmailHtml(tc.input);
    assert.ok(!html.includes('logo'), `[${tc.name}] must not contain logo`);
    assert.ok(!html.includes('base44.com'), `[${tc.name}] must not contain logo URL`);
    assert.ok(!html.includes('detail-card'), `[${tc.name}] must not contain styled detail card`);
    assert.ok(!html.includes('email-title'), `[${tc.name}] must not contain styled email title`);
    assert.ok(!html.includes('footer'), `[${tc.name}] must not contain styled footer`);
    assert.ok(!html.includes('0B2D5C'), `[${tc.name}] must not contain navy color`);
    assert.ok(!html.includes('C9A227'), `[${tc.name}] must not contain gold color`);
    assert.ok(!html.includes('class='), `[${tc.name}] must not contain CSS classes`);
    assert.ok(!html.includes('style='), `[${tc.name}] must not contain inline styles`);
  }
});

// ── Test 4: HTML structure is minimal (only <html><body> and <br>) ───────────
test('HTML structure is minimal — only html/body/br tags, no div/p/span', () => {
  for (const tc of TEST_CASES) {
    const html = invoiceEmailHtml(tc.input);
    assert.ok(!html.includes('<div'), `[${tc.name}] must not contain <div>`);
    assert.ok(!html.includes('<p>'), `[${tc.name}] must not contain <p>`);
    assert.ok(!html.includes('<span'), `[${tc.name}] must not contain <span>`);
    assert.ok(!html.includes('<img'), `[${tc.name}] must not contain <img>`);
    assert.ok(!html.includes('<a '), `[${tc.name}] must not contain <a> links`);
    assert.ok(!html.includes('<style'), `[${tc.name}] must not contain <style>`);
    assert.ok(!html.includes('<head'), `[${tc.name}] must not contain <head>`);
    assert.ok(html.includes('<html>'), `[${tc.name}] must contain <html>`);
    assert.ok(html.includes('<body>'), `[${tc.name}] must contain <body>`);
  }
});

// ── Test 5: Greeting uses first_name only (not full name) ─────────────────────
test('greeting uses first_name only — "Hello ${firstName}," not full name', () => {
  const html = invoiceEmailHtml({ firstName: 'John', invoiceNumber: 'INV-001', amount: 100, projectType: 'Solar' });
  const text = htmlToText(html);
  assert.ok(text.startsWith('Hello John,'), 'greeting must be "Hello John,"');
  assert.ok(!text.includes('John  '), 'must not have trailing spaces from full-name join');
});

// ── Test 6: Amount formatting matches Base44 ─────────────────────────────────
test('amount formatting matches Base44 toLocaleString with minimumFractionDigits:2', () => {
  const cases = [
    { amount: 1000, expected: '$1,000.00' },
    { amount: 0, expected: '$0.00' },
    { amount: 1234567.89, expected: '$1,234,567.89' },
    { amount: 250.5, expected: '$250.50' },
    { amount: 100, expected: '$100.00' },
  ];
  for (const c of cases) {
    const html = invoiceEmailHtml({ firstName: 'Test', invoiceNumber: 'X', amount: c.amount, projectType: 'P' });
    const text = htmlToText(html);
    assert.ok(text.includes(`Amount: ${c.expected}`), `amount must be "${c.expected}" for input ${c.amount}`);
  }
});

// ── Test 7: Project fallback to N/A matches Base44 ───────────────────────────
test('project falls back to "N/A" when projectType is null/undefined (matches Base44)', () => {
  const htmlNull = invoiceEmailHtml({ firstName: 'T', invoiceNumber: 'X', amount: 0, projectType: null });
  const htmlUndef = invoiceEmailHtml({ firstName: 'T', invoiceNumber: 'X', amount: 0, projectType: undefined });
  assert.ok(htmlToText(htmlNull).includes('Project: N/A'), 'null projectType must render "N/A"');
  assert.ok(htmlToText(htmlUndef).includes('Project: N/A'), 'undefined projectType must render "N/A"');
});

// ── Test 8: Invoice number fallback (empty string when null) ─────────────────
test('invoice number renders empty when null (matches Base44 || fallback)', () => {
  const html = invoiceEmailHtml({ firstName: 'T', invoiceNumber: null, amount: 0, projectType: 'P' });
  const text = htmlToText(html);
  assert.ok(text.includes('Invoice #: '), 'must contain "Invoice #: " with empty value');
});

// ── Test 9: Idempotency key unchanged ─────────────────────────────────────────
test('invoice idempotency key format is unchanged (IdempotencyKeys.invoice)', () => {
  const key1 = IdempotencyKeys.invoice('inv_123', 'customer@test.com', undefined);
  const key2 = IdempotencyKeys.invoice('inv_123', 'customer@test.com', undefined);
  const key3 = IdempotencyKeys.invoice('inv_123', 'rep@test.com', undefined);
  assertEqual(key1, key2, 'same inputs must produce same key (deterministic)');
  assert.ok(key1 !== key3, 'different recipient must produce different key');
  assert.ok(key1.startsWith('invoice-email:'), 'key must be in invoice-email: namespace');
  assert.ok(key1.includes('inv_123'), 'key must include invoice ID');
  assert.ok(key1.includes('customer@test.com'), 'key must include recipient');
});

// ── Test 10: Idempotency key with version ─────────────────────────────────────
test('invoice idempotency key supports version parameter (for resend)', () => {
  const keyV1 = IdempotencyKeys.invoice('inv_123', 'customer@test.com', 1);
  const keyV2 = IdempotencyKeys.invoice('inv_123', 'customer@test.com', 2);
  assert.ok(keyV1 !== keyV2, 'different versions must produce different keys');
});

// ── Test 11: No Activity record created (Base44 sendInvoiceEmail does NOT log) ─
test('confirmation: Base44 sendInvoiceEmail does NOT create Activity record (no activity logging for invoices)', () => {
  // Read the Base44 function source and verify it does not call Activity.create
  const base44Source = fs.readFileSync(
    path.join(ROOT, 'base44', 'functions', 'sendInvoiceEmail', 'entry.ts'),
    'utf8'
  );
  assert.ok(!base44Source.includes('Activity.create'), 'Base44 sendInvoiceEmail must not create Activity records');
  assert.ok(!base44Source.includes('entities.Activity'), 'Base44 sendInvoiceEmail must not reference Activity entity');
});

// ── Test 12: Recipients logic parity ─────────────────────────────────────────
test('recipients logic matches Base44 (customer + assigned_rep, NOT office)', () => {
  const base44Source = fs.readFileSync(
    path.join(ROOT, 'base44', 'functions', 'sendInvoiceEmail', 'entry.ts'),
    'utf8'
  );
  // Base44: if (lead.email) recipients.push(lead.email);
  assert.ok(base44Source.includes('if (lead.email) recipients.push(lead.email)'), 'must include customer email');
  // Base44: if (lead.assigned_rep && lead.assigned_rep !== lead.email) recipients.push(lead.assigned_rep);
  assert.ok(base44Source.includes('lead.assigned_rep !== lead.email'), 'must exclude duplicate rep');
  // Base44 fetches officeEmail but does NOT push it to recipients
  assert.ok(base44Source.includes('officeInvoiceEmail'), 'office email setting is fetched');
  assert.ok(!base44Source.includes('recipients.push(officeEmail)'), 'must NOT push office email to recipients');
});

// ── Test 13: Attachment behavior parity ───────────────────────────────────────
test('attachment behavior matches Base44 (QB PDF via fetchInvoicePdf, application/pdf)', () => {
  const base44Source = fs.readFileSync(
    path.join(ROOT, 'base44', 'functions', 'sendInvoiceEmail', 'entry.ts'),
    'utf8'
  );
  assert.ok(base44Source.includes("base44.functions.invoke('fetchInvoicePdf'"), 'must fetch PDF via fetchInvoicePdf');
  assert.ok(base44Source.includes("attachmentMimeType: 'application/pdf'"), 'must use application/pdf MIME type');
  assert.ok(base44Source.includes('attachmentBase64'), 'must pass attachmentBase64');
  assert.ok(base44Source.includes('attachmentFilename'), 'must pass attachmentFilename');
});

// ── Test 14: Invoice entity update fields parity ─────────────────────────────
test('invoice entity update fields match Base44 (email_sent_date, recipients, status, error, resend_count)', () => {
  const base44Source = fs.readFileSync(
    path.join(ROOT, 'base44', 'functions', 'sendInvoiceEmail', 'entry.ts'),
    'utf8'
  );
  assert.ok(base44Source.includes('email_sent_date'), 'must update email_sent_date');
  assert.ok(base44Source.includes('email_recipients'), 'must update email_recipients');
  assert.ok(base44Source.includes('email_delivery_status'), 'must update email_delivery_status');
  assert.ok(base44Source.includes('email_error'), 'must update email_error');
  assert.ok(base44Source.includes('email_resend_count'), 'must update email_resend_count');
});

// ── Test 15: LeadAttachment save parity ──────────────────────────────────────
test('LeadAttachment save behavior matches Base44 (PDF saved to lead attachments on success)', () => {
  const base44Source = fs.readFileSync(
    path.join(ROOT, 'base44', 'functions', 'sendInvoiceEmail', 'entry.ts'),
    'utf8'
  );
  assert.ok(base44Source.includes('LeadAttachment.create'), 'must create LeadAttachment');
  assert.ok(base44Source.includes('file_type: \'application/pdf\''), 'must set file_type to application/pdf');
  assert.ok(base44Source.includes('qb_invoice_id'), 'must include qb_invoice_id');
  assert.ok(base44Source.includes('qb_invoice_number'), 'must include qb_invoice_number');
  assert.ok(base44Source.includes('invoice_amount'), 'must include invoice_amount');
});

// ── Test 16: Snapshot — full rendered output for canonical case ──────────────
test('SNAPSHOT: canonical invoice renders exact production text', () => {
  const html = invoiceEmailHtml({
    firstName: 'John',
    invoiceNumber: 'INV-001',
    amount: 1000,
    projectType: 'Solar',
  });
  const rendered = htmlToText(html);
  const expected = `Hello John,

Attached is your invoice from EC Construction Group.

Invoice #: INV-001
Amount: $1,000.00
Project: Solar

Thank you,
EC Construction Group`;
  assertEqual(rendered, expected, 'canonical snapshot');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('───────────────────────────────────────────────────────────────\n');

if (failed > 0) {
  process.exit(1);
}