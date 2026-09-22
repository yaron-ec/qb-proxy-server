import { describe, it, expect } from 'vitest';
import { classifyVendorExpenses } from './financialCalc';

/**
 * financialCalc.expenses.test.jsx — "Include in profit calculation"
 * checked/unchecked, and financial recalculation from persisted values.
 *
 * Companion to the production expense-save bug (routes/dealExpenses.js's
 * malformed UPDATE SQL, fixed separately): this proves that once an
 * expense is correctly persisted, the financial summary recalculates from
 * exactly what's in the database — never from stale/cached state, and
 * never mutating historical expenses.
 */
function expense(overrides = {}) {
  return { category: 'Materials', amount: 100, amount_paid: 0, payment_status: 'Unpaid', include_in_profit_calculation: true, ...overrides };
}

describe('classifyVendorExpenses — include/exclude from profit calculation', () => {
  it('an expense with include_in_profit_calculation=true is counted', () => {
    const out = classifyVendorExpenses([expense({ category: 'Materials', amount: 400, include_in_profit_calculation: true })]);
    expect(out.material.committed).toBe(400);
  });

  it('an expense with include_in_profit_calculation=false is excluded entirely from profit', () => {
    const out = classifyVendorExpenses([expense({ category: 'Materials', amount: 400, include_in_profit_calculation: false })]);
    expect(out.material.committed).toBe(0);
  });

  it('a Cancelled expense is excluded regardless of include_in_profit_calculation', () => {
    const out = classifyVendorExpenses([expense({ amount: 400, payment_status: 'Cancelled', include_in_profit_calculation: true })]);
    expect(out.material.committed).toBe(0);
  });

  it('recalculates from the persisted amount after an edit — not a stale cached value', () => {
    const before = classifyVendorExpenses([expense({ category: 'HVAC', amount: 400 })]);
    expect(before.other.committed).toBe(400);
    // Simulate the DB row after a successful edit (the production bug this
    // accompanies made this edit fail before the SQL fix).
    const after = classifyVendorExpenses([expense({ category: 'HVAC', amount: 450 })]);
    expect(after.other.committed).toBe(450);
  });

  it('editing one expense does not change the recognized total of an unrelated, untouched historical expense', () => {
    const historical = expense({ category: 'Subcontractor', amount: 1000, include_in_profit_calculation: true });
    const edited = expense({ category: 'HVAC', amount: 450 });
    const out = classifyVendorExpenses([historical, edited]);
    expect(out.subcontractor.committed).toBe(1000);
    expect(out.other.committed).toBe(450);
  });

  it('Paid vs Unpaid status does not change the committed (profit-recognized) amount — only amount_paid does', () => {
    const paid = classifyVendorExpenses([expense({ category: 'HVAC', amount: 400, payment_status: 'Paid', amount_paid: 400 })]);
    const unpaid = classifyVendorExpenses([expense({ category: 'HVAC', amount: 400, payment_status: 'Unpaid', amount_paid: 0 })]);
    expect(paid.other.committed).toBe(400);
    expect(unpaid.other.committed).toBe(400);
    expect(paid.other.paid).toBe(400);
    expect(unpaid.other.paid).toBe(0);
  });

  it('a Refunded expense subtracts from its category total (a genuine cost reversal)', () => {
    const out = classifyVendorExpenses([
      expense({ category: 'Materials', amount: 400, payment_status: 'Unpaid' }),
      expense({ category: 'Materials', amount: 400, payment_status: 'Refunded' }),
    ]);
    expect(out.material.committed).toBe(0);
  });

  it('handles an empty/undefined expenses list safely', () => {
    expect(classifyVendorExpenses([]).other.committed).toBe(0);
    expect(classifyVendorExpenses(undefined).other.committed).toBe(0);
  });
});
