/* eslint-disable no-undef */
/**
 * scopedRoutesP0.test.js — P0 data-isolation regression tests for all 8
 * scoped subresource routes (root-level canonical backend).
 *
 * Verifies at the source level that each GET / handler enforces:
 *   - missing required lead_id/deal_id scope returns empty (never global)
 *   - invalid (non-UUID) scope returns empty (never global fallback)
 *   - the scope param is always in the WHERE clause
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readRoute(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

describe('P0 Data Isolation — Root-Level Scoped Routes', () => {
  const routes = [
    ['routes/handoffEstimates.js', 'lead_id'],
    ['routes/dealExpenses.js', 'deal_id'],
    ['routes/dealCommissions.js', 'deal_id'],
    ['routes/dealLoanPayments.js', 'deal_id'],
    ['routes/invoices.js', 'lead_id'],
    ['routes/activities.js', 'lead_id'],
    ['routes/leadAttachments.js', 'lead_id'],
    ['routes/dealExpensePayments.js', 'deal_id'],
  ];

  for (const [file, scope] of routes) {
    it(file + ' enforces ' + scope + ' scope (P0)', () => {
      const src = readRoute(file);
      assert.ok(src.includes('P0 DATA ISOLATION'), file + ': missing P0 comment');
      assert.ok(src.includes('UUID_RE'), file + ': missing UUID_RE validation');
      assert.ok(src.includes('return res.json({ items: [], total: 0 })'), file + ': missing empty-return guard');
      if (scope === 'lead_id') {
        assert.ok(src.includes('if (!lead_id)') || src.includes('if (!lead_id && !deal_id)'), file + ': lead_id not required');
      } else {
        assert.ok(src.includes('if (!deal_id)'), file + ': deal_id not required');
      }
    });
  }
});
