/* eslint-disable no-undef */
'use strict';

/**
 * crmUrl.test.js — lib/crmUrl.js, the centralized, validated source of the
 * CRM's absolute base URL for every outbound-email lead link.
 *
 * Production incident (November 2026, lead 774d31bd-1134-4319-8298-5810dbe196a5):
 * a New Lead notification email's "Open Lead in CRM" button opened
 * http:///leads/774d31bd-... on mobile — scheme present, host EMPTY. Root
 * cause: lib/captureAlerts.js#sendNewLeadAlert built its lead link from a
 * caller-supplied `crmPublicUrl` with NO fallback, and its real callers all
 * passed `process.env.CRM_PUBLIC_URL || ''` — when the env var was unset in
 * production, the email shipped a bare RELATIVE path baked into its HTML.
 * These tests prove getCrmBaseUrl()/buildLeadUrl() can never reproduce that:
 * they always return a valid, absolute http(s) URL with a real host.
 */
const test = require('node:test');
const assert = require('node:assert');

function freshCrmUrl() {
  delete require.cache[require.resolve('../lib/crmUrl')];
  return require('../lib/crmUrl');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('getCrmBaseUrl: CRM_PUBLIC_URL unset -> falls back to the known production CRM URL', () => {
  withEnv({ CRM_PUBLIC_URL: undefined }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
  });
});

test('getCrmBaseUrl: CRM_PUBLIC_URL="" (empty string) -> falls back, never a bare scheme or empty host', () => {
  withEnv({ CRM_PUBLIC_URL: '' }, () => {
    const crmUrl = freshCrmUrl();
    const url = crmUrl.getCrmBaseUrl();
    assert.strictEqual(url, 'https://crm.ecconstructiongroup.com');
    assert.ok(!/^https?:\/\/$/.test(url), 'must never be a bare scheme with no host');
  });
});

test('getCrmBaseUrl: a valid, correctly-configured CRM_PUBLIC_URL is used as-is (normalized, no trailing slash)', () => {
  withEnv({ CRM_PUBLIC_URL: 'https://crm.ecconstructiongroup.com/' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
  });
});

test('getCrmBaseUrl: a valid non-default host (e.g. a Railway-generated company domain) is honored', () => {
  withEnv({ CRM_PUBLIC_URL: 'https://acme-crm-production.up.railway.app' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://acme-crm-production.up.railway.app');
  });
});

test('getCrmBaseUrl: http (non-TLS) is still accepted as a valid protocol (never silently upgraded or rejected)', () => {
  withEnv({ CRM_PUBLIC_URL: 'http://example.com' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'http://example.com');
  });
});

test('getCrmBaseUrl: an unparsable value falls back, never throws', () => {
  withEnv({ CRM_PUBLIC_URL: 'http://' }, () => {
    const crmUrl = freshCrmUrl();
    // "http://" with no host is EXACTLY the shape of the reported incident
    // if it ever reached new URL() unvalidated — must still fall back safely.
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
  });
});

test('getCrmBaseUrl: "not a url at all" falls back, never throws', () => {
  withEnv({ CRM_PUBLIC_URL: 'not a url at all' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
  });
});

test('getCrmBaseUrl: a non-http(s) protocol (e.g. file://, javascript:) is rejected, falls back', () => {
  withEnv({ CRM_PUBLIC_URL: 'javascript:alert(1)' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
  });
});

for (const blocked of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://0.0.0.0', 'https://api.railway.internal', 'https://base44.app', 'https://media.base44.com', 'https://base44.com']) {
  test(`getCrmBaseUrl: blocked host "${blocked}" is rejected, falls back to the production CRM URL`, () => {
    withEnv({ CRM_PUBLIC_URL: blocked }, () => {
      const crmUrl = freshCrmUrl();
      assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://crm.ecconstructiongroup.com');
    });
  });
}

test('getCrmBaseUrl: a *.up.railway.app domain is NOT blocked (a legitimate per-company frontend before a custom domain is attached)', () => {
  withEnv({ CRM_PUBLIC_URL: 'https://some-company-production.up.railway.app' }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.getCrmBaseUrl(), 'https://some-company-production.up.railway.app');
  });
});

test('buildLeadUrl: produces an absolute URL with the lead id appended', () => {
  withEnv({ CRM_PUBLIC_URL: undefined }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(
      crmUrl.buildLeadUrl('774d31bd-1134-4319-8298-5810dbe196a5'),
      'https://crm.ecconstructiongroup.com/leads/774d31bd-1134-4319-8298-5810dbe196a5'
    );
  });
});

test('buildLeadUrl: never produces the reported incident shape (scheme present, host empty)', () => {
  withEnv({ CRM_PUBLIC_URL: undefined }, () => {
    const crmUrl = freshCrmUrl();
    const url = crmUrl.buildLeadUrl('774d31bd-1134-4319-8298-5810dbe196a5');
    assert.ok(!/^https?:\/\/\//.test(url), 'must never be scheme + empty host (the exact reported bug)');
    assert.ok(/^https:\/\/[^/]+\/leads\//.test(url), 'must be a genuine absolute URL with a non-empty host');
  });
});

test('buildLeadUrl: missing leadId returns null — callers must omit the link entirely, never emit "/leads/" or "/leads/undefined"', () => {
  const crmUrl = freshCrmUrl();
  assert.strictEqual(crmUrl.buildLeadUrl(null), null);
  assert.strictEqual(crmUrl.buildLeadUrl(undefined), null);
  assert.strictEqual(crmUrl.buildLeadUrl(''), null);
});

test('buildLeadUrl: encodes the lead id for URL safety', () => {
  withEnv({ CRM_PUBLIC_URL: undefined }, () => {
    const crmUrl = freshCrmUrl();
    assert.strictEqual(crmUrl.buildLeadUrl('a b'), 'https://crm.ecconstructiongroup.com/leads/a%20b');
  });
});

test('isBlockedHost: exported for direct use, matches documented hosts', () => {
  const crmUrl = freshCrmUrl();
  assert.strictEqual(crmUrl.isBlockedHost('localhost'), true);
  assert.strictEqual(crmUrl.isBlockedHost('LOCALHOST'), true);
  assert.strictEqual(crmUrl.isBlockedHost(''), true);
  assert.strictEqual(crmUrl.isBlockedHost(null), true);
  assert.strictEqual(crmUrl.isBlockedHost('crm.ecconstructiongroup.com'), false);
  assert.strictEqual(crmUrl.isBlockedHost('foo.up.railway.app'), false);
});
