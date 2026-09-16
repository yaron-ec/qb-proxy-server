/* eslint-disable no-undef */
'use strict';

/**
 * designSystemConsolidation.test.js — regression guard for the "four
 * overlapping design systems" problem identified during the CRM-wide
 * visual/UX pass:
 *
 *   lib/design-system.js, lib/crmDesignSystem.js, components/DesignSystem/,
 *   components/ui/ — four places a token or component could live.
 *
 * INVESTIGATION FINDING (verified, not assumed): lib/crmDesignSystem.js and
 * components/crm/* were a small, self-contained duplicate token set +
 * wrapper-component layer with exactly ONE real consumer
 * (components/AddNewProjectModal.jsx, using two of its seven wrapper
 * components) plus one fully orphaned/unrouted page (pages/CustomerProfile.jsx,
 * confirmed unreferenced from App.jsx or anywhere else). AddNewProjectModal.jsx
 * was migrated onto plain, inlined equivalents of the exact same className
 * strings (zero visual change) and CustomerProfile.jsx was removed, making
 * the entire lib/crmDesignSystem.js + components/crm/ layer dead code —
 * removed rather than left as a fourth competing source of truth.
 *
 * Canonical architecture going forward: components/ui/ (primitives),
 * components/DesignSystem/ (composed CRM components), lib/design-system.js
 * (the one token/utility source — documented in its own header).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

test('lib/crmDesignSystem.js and components/crm/ are removed, not left as a competing source', () => {
  assert.ok(!fs.existsSync(path.join(frontendSrc, 'lib', 'crmDesignSystem.js')));
  assert.ok(!fs.existsSync(path.join(frontendSrc, 'components', 'crm')));
});

test('pages/CustomerProfile.jsx (the one orphaned page depending on the removed layer) is removed', () => {
  assert.ok(!fs.existsSync(path.join(frontendSrc, 'pages', 'CustomerProfile.jsx')));
});

test('no remaining source file imports the removed crmDesignSystem/components/crm layer', () => {
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const offenders = [];
  for (const file of walk(frontendSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/from\s+["']@\/lib\/crmDesignSystem["']/.test(src) || /from\s+["']@\/components\/crm["']/.test(src)) {
      offenders.push(path.relative(frontendSrc, file));
    }
  }
  assert.deepStrictEqual(offenders, [], 'no file should still import the removed design-system layer');
});

test('lib/design-system.js documents itself as the canonical token source', () => {
  const src = fs.readFileSync(path.join(frontendSrc, 'lib', 'design-system.js'), 'utf8');
  assert.ok(/CANONICAL ARCHITECTURE/.test(src), 'must document the canonical architecture decision');
});

test('AddNewProjectModal.jsx preserves the exact prior field-label styling after migrating off CRMFieldLabel', () => {
  const src = fs.readFileSync(path.join(frontendSrc, 'components', 'AddNewProjectModal.jsx'), 'utf8');
  assert.ok(src.includes('text-[10px] font-semibold text-slate-500 uppercase tracking-wide'), 'field label classes must be preserved exactly (no visual regression)');
  assert.ok(!/<\s*CRMFieldLabel\b/.test(src), 'must no longer render the removed CRMFieldLabel component');
  assert.ok(!/<\s*CRMButton\b/.test(src), 'must no longer render the removed CRMButton component');
  assert.ok(!/from\s+["']@\/components\/crm["']/.test(src), 'must no longer import from the removed components/crm layer');
});
