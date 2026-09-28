/* eslint-disable no-undef */
/**
 * moduleGate — Express middleware enforcing company_settings.enabled_modules
 * (PRODUCTIZATION PHASE 2, Section 3: "module enablement must actually
 * work"). lib/companyConfig.js#isModuleEnabled() has existed since Phase 1
 * but nothing called it before this file.
 *
 * A disabled module's routes respond 404 module_disabled — never a 500/
 * missing-secret error, and never a fake "unhealthy" status — so a company
 * that doesn't use an integration never sees a broken feature, just one
 * that isn't there. GET /api/v1/system/info (routes/systemInfo.js) is the
 * place to see the accurate CONFIGURED/NOT_CONFIGURED/CONNECTED state; a
 * disabled module's feature routes are simply absent.
 */
'use strict';

const companyConfig = require('./companyConfig');

function requireModuleEnabled(moduleKey) {
  return async function (req, res, next) {
    try {
      const enabled = await companyConfig.isModuleEnabled(moduleKey);
      if (!enabled) {
        return res.status(404).json({ error: 'module_disabled', module: moduleKey, message: `The '${moduleKey}' module is not enabled for this installation.` });
      }
      next();
    } catch (e) {
      // A config-read failure should never masquerade as "module worked" —
      // but it also shouldn't 500 a route whose only fault is an unrelated
      // DB hiccup on an unrelated read. Fail open to "enabled" only for a
      // genuine infra error, matching this middleware's job (gate on
      // configuration, not become a second health check).
      console.error(`[moduleGate:${moduleKey}] config read failed, failing open:`, e.message);
      next();
    }
  };
}

module.exports = { requireModuleEnabled };
