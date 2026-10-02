/* eslint-disable no-undef */
'use strict';

/**
 * provisionCompany.test.js — unit coverage for the pure/file-system-only
 * helpers in scripts/install/provisionCompany.js (PRODUCTIZATION — Company
 * Provisioning System). The full DB-touching flow (bootstrap delegation,
 * installation-identity confirmation, health checks) is proven end-to-end
 * by test/integration/company3ProvisioningProof.int.test.js against a real
 * disposable Postgres database, which is a stronger guarantee than any mock
 * could give for that part.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prov = require('../scripts/install/provisionCompany');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provtest-'));
}

test('loadConfigFile: missing --config throws a clear usage error', () => {
  assert.throws(() => prov.loadConfigFile(null), /Usage: npm run provision-company/);
});

test('loadConfigFile: nonexistent file throws a clear error', () => {
  assert.throws(() => prov.loadConfigFile('/no/such/file.json'), /Config file not found/);
});

test('loadConfigFile: invalid JSON throws a clear error, not a raw SyntaxError', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => prov.loadConfigFile(p), /not valid JSON/);
});

test('loadConfigFile: valid JSON loads correctly', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'good.json');
  fs.writeFileSync(p, JSON.stringify({ company_name: 'Acme' }));
  assert.deepStrictEqual(prov.loadConfigFile(p), { company_name: 'Acme' });
});

test('redactConfig: strips admin_password, never leaks it in any form', () => {
  const cfg = { company_name: 'Acme', admin_password: 'super-secret-value-123' };
  const redacted = prov.redactConfig(cfg);
  assert.strictEqual(redacted.admin_password, '<redacted>');
  assert.strictEqual(redacted.company_name, 'Acme');
  assert.ok(!JSON.stringify(redacted).includes('super-secret-value-123'));
});

test('buildOnboardingChecklist: only lists ENABLED modules, never a disabled one', () => {
  const cfg = {
    frontend_url: 'https://crm.acme.example',
    backend_url: 'https://acme-api.example',
    enabled_modules: { quickbooks: true, gmail: false, handoff: true },
  };
  const checklist = prov.buildOnboardingChecklist(cfg);
  const modules = checklist.map((c) => c.module);
  assert.ok(modules.includes('quickbooks'));
  assert.ok(modules.includes('handoff'));
  assert.ok(!modules.includes('gmail'));
});

test('buildOnboardingChecklist: empty enabled_modules produces an empty checklist', () => {
  const checklist = prov.buildOnboardingChecklist({ enabled_modules: {} });
  assert.deepStrictEqual(checklist, []);
});

test('writeArtifacts: also writes a RAILWAY_DEPLOYMENT_PLAN.md artifact', () => {
  const dir = tmpDir();
  prov.writeArtifacts(dir, { company_name: 'Acme', enabled_modules: {} }, [], {});
  assert.ok(fs.existsSync(path.join(dir, 'RAILWAY_DEPLOYMENT_PLAN.md')));
});

test('writeArtifacts: env manifest includes a generated secret value when provided, and a placeholder comment when not', () => {
  const dir = tmpDir();
  const cfg = { company_name: 'Acme', frontend_url: 'https://crm.acme.example' };
  prov.writeArtifacts(dir, cfg, [], { RAILWAY_JWT_SECRET: 'deadbeef1234' });
  const manifest = fs.readFileSync(path.join(dir, 'env.manifest.txt'), 'utf8');
  assert.ok(manifest.includes('RAILWAY_JWT_SECRET=deadbeef1234'));
  assert.ok(manifest.includes('ENCRYPTION_KEY='));
  assert.ok(manifest.includes('generate with: openssl rand -hex 32'));
});

test('writeArtifacts: never writes admin_password or any FIELD_SPECS secret field value into the manifest or checklist', () => {
  const dir = tmpDir();
  const cfg = { company_name: 'Acme', frontend_url: 'https://crm.acme.example', admin_password: 'do-not-leak-this-literal' };
  const checklist = prov.buildOnboardingChecklist({ ...cfg, backend_url: 'https://api.acme.example', enabled_modules: { handoff: true } });
  prov.writeArtifacts(dir, cfg, checklist, {});
  const manifest = fs.readFileSync(path.join(dir, 'env.manifest.txt'), 'utf8');
  const md = fs.readFileSync(path.join(dir, 'ONBOARDING_CHECKLIST.md'), 'utf8');
  assert.ok(!manifest.includes('do-not-leak-this-literal'));
  assert.ok(!md.includes('do-not-leak-this-literal'));
});

test('writeArtifacts: a module with no enabled integrations produces a clean "nothing further required" checklist', () => {
  const dir = tmpDir();
  prov.writeArtifacts(dir, { company_name: 'Acme' }, [], {});
  const md = fs.readFileSync(path.join(dir, 'ONBOARDING_CHECKLIST.md'), 'utf8');
  assert.ok(md.includes('nothing further required'));
});

test('writeArtifacts: produces valid separation between multiple module sections (regression — flatMap+filter(Boolean) previously ate the blank-line separators)', () => {
  const dir = tmpDir();
  const checklist = prov.buildOnboardingChecklist({
    frontend_url: 'https://crm.acme.example', backend_url: 'https://api.acme.example',
    enabled_modules: { google_calendar: true, google_contacts: true },
  });
  prov.writeArtifacts(dir, { company_name: 'Acme' }, checklist, {});
  const md = fs.readFileSync(path.join(dir, 'ONBOARDING_CHECKLIST.md'), 'utf8');
  assert.match(md, /Google Calendar[\s\S]*?\n\n## Google Contacts/, 'expected a blank line between the two module sections');
});

test('buildDomainChecklistItem: returns null when no custom_domain is configured', () => {
  assert.strictEqual(prov.buildDomainChecklistItem({}), null);
});

test('buildDomainChecklistItem: returns DNS instructions naming the configured domain when custom_domain is set', () => {
  const item = prov.buildDomainChecklistItem({ custom_domain: 'crm.acme.example' });
  assert.ok(item);
  assert.strictEqual(item.domain, 'crm.acme.example');
  assert.strictEqual(item.requires_human_authorization, true);
  assert.match(item.instructions, /crm\.acme\.example/);
  assert.match(item.instructions, /CNAME/);
});

test('writeArtifacts: includes the custom domain checklist item in both the env manifest and the onboarding checklist when configured', () => {
  const dir = tmpDir();
  prov.writeArtifacts(dir, { company_name: 'Acme', custom_domain: 'crm.acme.example', enabled_modules: {} }, [], {});
  const manifest = fs.readFileSync(path.join(dir, 'env.manifest.txt'), 'utf8');
  const md = fs.readFileSync(path.join(dir, 'ONBOARDING_CHECKLIST.md'), 'utf8');
  assert.match(manifest, /crm\.acme\.example/);
  assert.match(md, /Custom domain: crm\.acme\.example/);
});

test('defaultOutDir: derives a filesystem-safe directory name from company_slug', () => {
  const out = prov.defaultOutDir({ company_slug: 'acme-remodeling' });
  assert.match(out, /provisioning-output[/\\]acme-remodeling[/\\]/);
});

test('defaultOutDir: falls back to "company" when company_slug is absent (should not happen after validation, but never crashes)', () => {
  const out = prov.defaultOutDir({});
  assert.match(out, /provisioning-output[/\\]company[/\\]/);
});
