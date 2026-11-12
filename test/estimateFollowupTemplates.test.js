/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupTemplates.test.js — pure unit coverage (no DB) for
 * lib/estimateFollowupTemplates.js: token rendering/escaping, the CAN-SPAM
 * compliance footer's ConfigurationError-when-unconfigured guarantee ("do
 * not invent a business address"), and saveTemplateVersion's
 * never-mutates-an-existing-row transaction (via a stubbed db.pool).
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshModule() {
  delete require.cache[require.resolve('../lib/estimateFollowupTemplates')];
  return require('../lib/estimateFollowupTemplates');
}

function makeDbStub({ queryImpl, poolClient } = {}) {
  return {
    query: queryImpl || (async () => ({ rows: [] })),
    pool: { connect: async () => poolClient },
  };
}

test('renderTokens: substitutes {{first_name}} and {{sales_rep_name}}, HTML-escaping both', () => {
  const restore = stub('../db/client', makeDbStub());
  const restoreCfg = stub('../lib/companyConfig', { getCompanyConfig: async () => ({}) });
  try {
    const m = freshModule();
    const out = m.renderTokens('Hi {{first_name}}, this is {{sales_rep_name}}.', { firstName: '<Jane>', salesRepName: 'Bob & Co' });
    assert.strictEqual(out, 'Hi &lt;Jane&gt;, this is Bob &amp; Co.');
  } finally { restore(); restoreCfg(); }
});

test('renderTokens: missing firstName/salesRepName fall back to safe defaults', () => {
  const restore = stub('../db/client', makeDbStub());
  try {
    const m = freshModule();
    const out = m.renderTokens('{{first_name}} / {{sales_rep_name}}', {});
    assert.strictEqual(out, 'there / Your EC Construction Group Representative');
  } finally { restore(); }
});

test('renderTokens: tolerates whitespace variations inside the token braces', () => {
  const restore = stub('../db/client', makeDbStub());
  try {
    const m = freshModule();
    const out = m.renderTokens('{{  first_name }}', { firstName: 'Sam' });
    assert.strictEqual(out, 'Sam');
  } finally { restore(); }
});

test('buildComplianceFooterHtml: throws ConfigurationError (never invents an address) when no address is configured', async () => {
  const restore = stub('../db/client', makeDbStub());
  const restoreCfg = stub('../lib/companyConfig', { getCompanyConfig: async () => ({ company_address: null, company_city: null, company_state: null, company_zip: null }) });
  try {
    const m = freshModule();
    await assert.rejects(() => m.buildComplianceFooterHtml('https://example.com/unsub'), m.ConfigurationError);
  } finally { restore(); restoreCfg(); }
});

test('buildComplianceFooterHtml: renders the real configured address + an unsubscribe link when configured', async () => {
  const restore = stub('../db/client', makeDbStub());
  const restoreCfg = stub('../lib/companyConfig', {
    getCompanyConfig: async () => ({
      company_name: 'EC Construction Group', company_address: '123 Main St', company_city: 'Los Angeles', company_state: 'CA', company_zip: '90001',
    }),
  });
  try {
    const m = freshModule();
    const html = await m.buildComplianceFooterHtml('https://crm.example.com/unsub/abc');
    assert.match(html, /123 Main St/);
    assert.match(html, /Los Angeles, CA/);
    assert.match(html, /90001/);
    assert.match(html, /EC Construction Group/);
    assert.match(html, /https:\/\/crm\.example\.com\/unsub\/abc/);
    assert.match(html, /Unsubscribe/);
  } finally { restore(); restoreCfg(); }
});

test('renderEmailForStep: throws a plain Error (not ConfigurationError) when no active template exists for the key', async () => {
  const restore = stub('../db/client', makeDbStub({ queryImpl: async () => ({ rows: [] }) }));
  try {
    const m = freshModule();
    await assert.rejects(() => m.renderEmailForStep({ templateKey: 'day1', firstName: 'Jane', salesRepName: 'Bob', unsubscribeUrl: 'https://x' }), /no active template/);
  } finally { restore(); }
});

test('renderEmailForStep: composes subject + html + templateVersion from the active template row', async () => {
  const restore = stub('../db/client', makeDbStub({
    queryImpl: async (sql) => {
      if (/estimate_followup_templates WHERE template_key/.test(sql)) {
        return { rows: [{ template_key: 'day1', version: 3, subject: 'Hi {{first_name}}', body_html: '<p>Hello {{first_name}} from {{sales_rep_name}}</p>' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  }));
  const restoreCfg = stub('../lib/companyConfig', {
    getCompanyConfig: async () => ({ company_name: 'EC Construction Group', company_address: '123 Main St', company_city: 'LA', company_state: 'CA', company_zip: '90001' }),
  });
  try {
    const m = freshModule();
    const result = await m.renderEmailForStep({ templateKey: 'day1', firstName: 'Jane', salesRepName: 'Bob', unsubscribeUrl: 'https://x/unsub' });
    assert.strictEqual(result.subject, 'Hi Jane');
    assert.strictEqual(result.templateVersion, 3);
    assert.match(result.html, /Hello Jane from Bob/);
    assert.match(result.html, /123 Main St/); // the compliance footer is appended
  } finally { restore(); restoreCfg(); }
});

test('saveTemplateVersion: rejects missing subject/bodyHtml/unknown key without touching the DB', async () => {
  const restore = stub('../db/client', makeDbStub());
  try {
    const m = freshModule();
    await assert.rejects(() => m.saveTemplateVersion({ templateKey: 'not-a-real-key', subject: 'x', bodyHtml: 'y' }), /unknown template key/);
    await assert.rejects(() => m.saveTemplateVersion({ templateKey: 'day1', subject: '', bodyHtml: 'y' }), /subject is required/);
    await assert.rejects(() => m.saveTemplateVersion({ templateKey: 'day1', subject: 'x', bodyHtml: '' }), /bodyHtml is required/);
  } finally { restore(); }
});

test('saveTemplateVersion: never mutates an existing row — inserts version = max+1, flips the old active row off, in one transaction', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
      if (/COALESCE\(MAX\(version\), 0\)/.test(sql)) return { rows: [{ max_version: 2 }] };
      if (/UPDATE estimate_followup_templates SET is_active = FALSE/.test(sql)) return { rows: [] };
      if (/INSERT INTO estimate_followup_templates/.test(sql)) return { rows: [{ template_key: params[0], version: params[1], subject: params[2], body_html: params[3], is_active: true, created_by: params[4] }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  const restore = stub('../db/client', makeDbStub({ poolClient: client }));
  try {
    const m = freshModule();
    const saved = await m.saveTemplateVersion({ templateKey: 'day1', subject: 'New subject', bodyHtml: '<p>New body</p>', createdBy: 'admin@example.com' });
    assert.strictEqual(saved.version, 3); // max(2) + 1
    assert.strictEqual(saved.is_active, true);

    const sqlJoined = calls.map((c) => c.sql).join(' | ');
    assert.match(sqlJoined, /BEGIN/);
    assert.match(sqlJoined, /UPDATE estimate_followup_templates SET is_active = FALSE/);
    assert.match(sqlJoined, /INSERT INTO estimate_followup_templates/);
    assert.match(sqlJoined, /COMMIT/);
    // The UPDATE call only ever flips is_active — it must never touch
    // subject/body_html (that would mean mutating the previous version's
    // content in place, exactly what this function must never do).
    const updateCall = calls.find((c) => /UPDATE estimate_followup_templates SET is_active = FALSE/.test(c.sql));
    assert.ok(updateCall, 'expected the is_active=FALSE update call');
    assert.ok(!/body_html|subject\s*=/.test(updateCall.sql));
  } finally { restore(); }
});

test('saveTemplateVersion: a DB error rolls back and still releases the client', async () => {
  let released = false;
  const client = {
    query: async (sql) => {
      if (/BEGIN/.test(sql)) return {};
      if (/COALESCE\(MAX\(version\), 0\)/.test(sql)) throw new Error('boom');
      if (/ROLLBACK/.test(sql)) return {};
      return {};
    },
    release: () => { released = true; },
  };
  const restore = stub('../db/client', makeDbStub({ poolClient: client }));
  try {
    const m = freshModule();
    await assert.rejects(() => m.saveTemplateVersion({ templateKey: 'day1', subject: 'x', bodyHtml: 'y' }), /boom/);
    assert.strictEqual(released, true);
  } finally { restore(); }
});
