/* eslint-disable no-undef */
'use strict';

/**
 * railwayPlan.test.js — unit coverage for scripts/install/railwayPlan.js
 * (PRODUCTIZATION — Company Provisioning System, Phase C).
 */
const test = require('node:test');
const assert = require('node:assert');
const plan = require('../scripts/install/railwayPlan');

test('computeRequiredServices: API, frontend, and postgres are always required', () => {
  const services = plan.computeRequiredServices({});
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  assert.strictEqual(byId.api.required, true);
  assert.strictEqual(byId.frontend.required, true);
  assert.strictEqual(byId.postgres.required, true);
});

test('computeRequiredServices: calendar-outbox-worker is NOT required when neither google_calendar nor google_contacts is enabled', () => {
  const services = plan.computeRequiredServices({ enabled_modules: { google_calendar: false, google_contacts: false, quickbooks: true } });
  const worker = services.find((s) => s.id === 'calendar-outbox-worker');
  assert.strictEqual(worker.required, false);
});

test('computeRequiredServices: calendar-outbox-worker IS required when google_calendar is enabled', () => {
  const services = plan.computeRequiredServices({ enabled_modules: { google_calendar: true } });
  const worker = services.find((s) => s.id === 'calendar-outbox-worker');
  assert.strictEqual(worker.required, true);
});

test('computeRequiredServices: calendar-outbox-worker IS required when ONLY google_contacts is enabled (not just google_calendar)', () => {
  const services = plan.computeRequiredServices({ enabled_modules: { google_calendar: false, google_contacts: true } });
  const worker = services.find((s) => s.id === 'calendar-outbox-worker');
  assert.strictEqual(worker.required, true);
});

test('computeRequiredServices: reminder-worker is an operator decision (required: null), never forced on or off', () => {
  const services = plan.computeRequiredServices({});
  const worker = services.find((s) => s.id === 'reminder-worker');
  assert.strictEqual(worker.required, null);
});

test('computeRequiredServices: never includes a production-watchdog or any service not in the verified 5-service topology', () => {
  const services = plan.computeRequiredServices({ enabled_modules: { quickbooks: true, gmail: true, google_calendar: true, google_contacts: true, signnow: true, handoff: true, meta: true, sms: true, website_intake: true } });
  const ids = services.map((s) => s.id);
  assert.deepStrictEqual(ids.sort(), ['api', 'calendar-outbox-worker', 'frontend', 'postgres', 'reminder-worker'].sort());
});

test('renderDeploymentPlanMarkdown: lists required services under "Add these services" and skipped ones under "Not needed"', () => {
  const cfg = { company_name: 'Acme Remodeling', enabled_modules: {} };
  const services = plan.computeRequiredServices(cfg);
  const md = plan.renderDeploymentPlanMarkdown(cfg, services);
  assert.match(md, /### Backend API/);
  assert.match(md, /### Frontend CRM SPA/);
  assert.match(md, /## Not needed for this installation/);
  assert.match(md, /Calendar \/ Google Contacts outbox worker/);
});

test('renderDeploymentPlanMarkdown: never names EC\'s own Railway project devoted-courtesy as where to deploy the NEW company', () => {
  const cfg = { company_name: 'Acme Remodeling', enabled_modules: {} };
  const md = plan.renderDeploymentPlanMarkdown(cfg, plan.computeRequiredServices(cfg));
  assert.match(md, /do NOT reuse or add services to EC's own `devoted-courtesy` project/);
});

test('renderDeploymentPlanMarkdown: includes the configured company_name, not a hardcoded example name', () => {
  const cfg = { company_name: 'Zzyzx Construction LLC', enabled_modules: {} };
  const md = plan.renderDeploymentPlanMarkdown(cfg, plan.computeRequiredServices(cfg));
  assert.match(md, /Zzyzx Construction LLC/);
});
