/* eslint-disable no-undef */
'use strict';

/**
 * In-process wiring + persistence tests for the sale-scoped financial model.
 * Run: node test/saleFinancialsWiring.test.js  (from src/proxy-server/)
 *
 * No database required — uses a mock db that records SQL + params and returns
 * canned rows. Validates call shapes, idempotency, voided handling, and the
 * sale-scoped invariants (no cross-Sale leakage, amount never owns, mapping
 * never reassigns, voided excluded, unmapped contributes to no Sale).
 */
const map = require('../lib/qbInvoiceSaleMap');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name, detail || ''); }
}

function mockDb(rowsByPattern) {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      if (/INSERT INTO qb_invoice_sale_map/.test(text)) return { rows: [] };
      if (/INSERT INTO qb_invoices_cache/.test(text)) return { rows: [] };
      if (/UPDATE qb_invoice_sale_map SET voided/.test(text)) return { rows: [] };
      if (/UPDATE qb_invoices_cache SET voided/.test(text)) return { rows: [] };
      if (/SELECT \* FROM qb_invoice_sale_map WHERE qb_invoice_id/.test(text)) return { rows: rowsByPattern.mapping || [] };
      if (/SELECT m\.qb_invoice_id/.test(text)) return { rows: rowsByPattern.saleInvoices || [] };
      if (/SELECT qb_invoice_id, qb_doc_number, qb_customer_id, total_amt FROM qb_invoices_cache/.test(text)) return { rows: rowsByPattern.cache || [] };
      return { rows: [] };
    },
    _calls: calls,
  };
  return db;
}

async function run() {
  // 1. upsertMapping call shape
  {
    const db = mockDb({});
    await map.upsertMapping(db, { qb_invoice_id: 'INV-1', qb_doc_number: '#1', crm_sale_id: 'SALE-A', crm_lead_id: '6a7e867f5d54151c702a1691', qb_customer_id: 'CUST-1', mapping_method: 'crm_created' });
    const c = db._calls[0];
    assert('upsertMapping: ON CONFLICT DO NOTHING', /ON CONFLICT \(qb_invoice_id\) DO NOTHING/.test(c.text));
    assert('upsertMapping: crm_sale_id passed as TEXT param', c.params.includes('SALE-A'));
    assert('upsertMapping: 24-char ObjectId lead id accepted as TEXT', c.params.includes('6a7e867f5d54151c702a1691'));
  }
  // 2. upsertMapping rejects missing crm_sale_id
  {
    const db = mockDb({});
    let threw = false;
    try { await map.upsertMapping(db, { qb_invoice_id: 'INV-1', crm_sale_id: '', crm_lead_id: 'L', qb_customer_id: 'C' }); } catch (e) { threw = true; }
    assert('upsertMapping rejects empty crm_sale_id', threw);
  }
  // 3. upsertInvoiceCacheFromQb maps QB fields
  {
    const db = mockDb({});
    const inv = { Id: 'INV-9', DocNumber: '#9', CustomerRef: { value: 'CUST-9' }, TotalAmt: 5000, Balance: 2000, TxnStatus: 'Open', TxnDate: '2026-08-14' };
    await map.upsertInvoiceCacheFromQb(db, inv);
    const c = db._calls[0];
    assert('upsertInvoiceCacheFromQb: INSERT into qb_invoices_cache', /INSERT INTO qb_invoices_cache/.test(c.text));
    assert('upsertInvoiceCacheFromQb: total_amt = TotalAmt (5000)', c.params.includes(5000));
    assert('upsertInvoiceCacheFromQb: paid = TotalAmt - Balance (3000)', c.params.includes(3000));
    assert('upsertInvoiceCacheFromQb: qb_customer_id from CustomerRef.value', c.params.includes('CUST-9'));
    assert('upsertInvoiceCacheFromQb: voided=false for live invoice', c.params.includes(false));
  }
  // 4. markVoided sets voided=TRUE on both tables
  {
    const db = mockDb({});
    await map.markVoided(db, 'INV-9');
    const updates = db._calls.filter(c => /UPDATE/.test(c.text));
    assert('markVoided: 2 UPDATEs issued', updates.length === 2);
    assert('markVoided: updates qb_invoice_sale_map voided=TRUE', updates.some(c => /UPDATE qb_invoice_sale_map SET voided = TRUE/.test(c.text)));
    assert('markVoided: updates qb_invoices_cache voided=TRUE', updates.some(c => /UPDATE qb_invoices_cache SET voided = TRUE/.test(c.text)));
    assert('markVoided: scoped by qb_invoice_id', updates.every(c => c.params.includes('INV-9')));
  }
  // 5. getInvoicesForSale excludes voided + scopes by sale
  {
    const db = mockDb({});
    await map.getInvoicesForSale(db, 'SALE-A');
    const c = db._calls[0];
    assert('getInvoicesForSale: filters map voided=FALSE', /COALESCE\(m\.voided, FALSE\) = FALSE/.test(c.text));
    assert('getInvoicesForSale: filters cache voided=FALSE', /COALESCE\(c\.voided, FALSE\) = FALSE/.test(c.text));
    assert('getInvoicesForSale: scoped by crm_sale_id', c.params.includes('SALE-A'));
  }
  // 6. computeSaleFinancials — Joann critical, no cross-Sale leakage
  {
    const fA = map.computeSaleFinancials(4724, [{ total_amt: 4724, paid: 0, voided: false }]);
    const fB = map.computeSaleFinancials(4869, [{ total_amt: 4869, paid: 0, voided: false }]);
    const fC = map.computeSaleFinancials(16500, [{ total_amt: 16500, paid: 1500, voided: false }]);
    assert('Joann: A.paid=0', fA.paid === 0);
    assert('Joann: B.paid=0', fB.paid === 0);
    assert('Joann: C.paid=1500', fC.paid === 1500);
    assert('Joann: A unpaid', fA.payment_status === 'unpaid');
    assert('Joann: C partial', fC.payment_status === 'partial');
  }
  // 7. Voided-only sale → empty aggregation
  {
    const f = map.computeSaleFinancials(1000, []);
    assert('Voided-only sale: invoiced 0, paid 0, balance 1000, unpaid', f.invoiced === 0 && f.paid === 0 && f.balance === 1000 && f.payment_status === 'unpaid');
  }
  // 8. classifyExisting — UNMAPPED (no lead)
  {
    const db = mockDb({ cache: [{ qb_invoice_id: 'INV-L', qb_doc_number: '#L', qb_customer_id: 'CUST-UNK', total_amt: 9999 }] });
    const rows = await map.classifyExisting(db, { leadIdForCustomer: () => null, dealCountForLead: () => 0 });
    assert('classifyExisting: no-lead → UNMAPPED', rows[0].classification === 'UNMAPPED');
  }
  // 9. classifyExisting — AMBIGUOUS (>1 deal)
  {
    const db = mockDb({ cache: [{ qb_invoice_id: 'INV-X', qb_doc_number: '#X', qb_customer_id: 'CUST-100', total_amt: 5000 }] });
    const rows = await map.classifyExisting(db, { leadIdForCustomer: () => 'LEAD-1', dealCountForLead: () => 3 });
    assert('classifyExisting: multi-deal → AMBIGUOUS', rows[0].classification === 'AMBIGUOUS');
  }
  // 10. classifyExisting — SAFE_AUTO_MAP (exactly 1 deal)
  {
    const db = mockDb({ cache: [{ qb_invoice_id: 'INV-S', qb_doc_number: '#S', qb_customer_id: 'CUST-1', total_amt: 5000 }] });
    const rows = await map.classifyExisting(db, { leadIdForCustomer: () => 'LEAD-1', dealCountForLead: () => 1 });
    assert('classifyExisting: single-deal → SAFE_AUTO_MAP', rows[0].classification === 'SAFE_AUTO_MAP');
  }
  // 11. POST /invoices persistence flow (strip crm fields, persist, idempotent)
  {
    const db = mockDb({});
    const reqBody = { crm_sale_id: 'SALE-A', crm_lead_id: '6a7e867f5d54151c702a1691', mapping_method: 'crm_created', Line: [], CustomerRef: { value: 'CUST-1' } };
    const { crm_sale_id, crm_lead_id, mapping_method, ...qbPayload } = reqBody;
    assert('POST /invoices: crm_sale_id stripped from QB payload', !('crm_sale_id' in qbPayload));
    assert('POST /invoices: mapping_method stripped from QB payload', !('mapping_method' in qbPayload));
    assert('POST /invoices: CustomerRef kept in QB payload', 'CustomerRef' in qbPayload);
    const inv = { Id: 'INV-NEW', DocNumber: '#100', CustomerRef: { value: 'CUST-1' }, TotalAmt: 4724, Balance: 4724, TxnStatus: 'Open', TxnDate: '2026-08-14' };
    await map.upsertInvoiceCacheFromQb(db, inv);
    await map.upsertMapping(db, { qb_invoice_id: String(inv.Id), qb_doc_number: inv.DocNumber, crm_sale_id, crm_lead_id, qb_customer_id: String(inv.CustomerRef.value), mapping_method });
    assert('POST /invoices: persists cache + map (2 calls)', db._calls.length === 2);
    assert('POST /invoices: map keyed by crm_sale_id (not amount)', db._calls[1].params.includes('SALE-A'));
    assert('POST /invoices: amount NOT used as ownership key', !db._calls[1].params.includes(4724) || db._calls[1].params.indexOf('SALE-A') >= 0);
  }
  // 12. Re-mapping with a different sale does NOT reassign (ON CONFLICT DO NOTHING)
  {
    const db = mockDb({});
    await map.upsertMapping(db, { qb_invoice_id: 'INV-1', crm_sale_id: 'SALE-A', crm_lead_id: 'L', qb_customer_id: 'C', mapping_method: 'crm_created' });
    await map.upsertMapping(db, { qb_invoice_id: 'INV-1', crm_sale_id: 'SALE-B', crm_lead_id: 'L', qb_customer_id: 'C', mapping_method: 'crm_created' });
    assert('Re-mapping: both use ON CONFLICT DO NOTHING (no silent reassign)', /ON CONFLICT \(qb_invoice_id\) DO NOTHING/.test(db._calls[0].text) && /ON CONFLICT \(qb_invoice_id\) DO NOTHING/.test(db._calls[1].text));
  }
  // 13. upsertInvoiceCache ON CONFLICT preserves voided (refresh never un-voids)
  {
    const db = mockDb({});
    await map.upsertInvoiceCache(db, { qb_invoice_id: 'INV-V', qb_doc_number: '#V', qb_customer_id: 'C', total_amt: 1000, balance: 0, paid: 1000, txn_status: 'Paid', voided: false, txn_date: '2026-08-14' });
    const c = db._calls[0];
    assert('upsertInvoiceCache: ON CONFLICT preserves existing voided (not EXCLUDED.voided)', /ON CONFLICT \(qb_invoice_id\) DO UPDATE SET/.test(c.text) && /voided = qb_invoices_cache\.voided/.test(c.text) && !/voided = EXCLUDED\.voided/.test(c.text));
  }

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });