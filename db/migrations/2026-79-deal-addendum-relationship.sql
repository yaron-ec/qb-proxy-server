-- CRM repair item 1 (November 2026): "Customer → Main Project → Addendums"
-- data model. Confirmed via the Ali & Mohemmed Lalani investigation (item
-- 5): a real accepted addendum (QuickBooks estimate HNDF-EST-10351,
-- "Toilet Area Floor Repair & Shower Re-Grout", Accepted, $7,934.35) had no
-- way to be represented as part of his original roof-replacement project —
-- a rep created it as a SECOND, entirely disconnected `deals` row instead,
-- with its own invoices misattributed elsewhere (see
-- routes/qbInvoiceMapping.js) and no link back to the parent project at
-- all. Every deal already has its own independent scope/documents/
-- expenses/invoices via existing FKs (deal_expenses.deal_id,
-- qb_invoice_sale_map.crm_sale_id, signnow_documents, deal_timeline, etc.)
-- — an addendum needs nothing new there. The ONE genuinely missing piece
-- is the relationship itself.
--
-- `parent_deal_id` is nullable (a deal with no parent is an ordinary,
-- independent project — the default, unchanged for every existing row) and
-- self-referencing. Deliberately ONE LEVEL DEEP ONLY (an addendum's own
-- parent_deal_id must itself be NULL, enforced in application code —
-- see lib/dealModel.js#canConvertToAddendum — never in a CHECK constraint,
-- since validating "my parent has no parent" needs a second table lookup a
-- CHECK constraint cannot perform) — nested addendums are out of scope for
-- this pass and were never requested.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS parent_deal_id UUID REFERENCES deals(id);
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_parent_deal_id_not_self;
ALTER TABLE deals ADD CONSTRAINT deals_parent_deal_id_not_self CHECK (parent_deal_id IS NULL OR parent_deal_id != id);
CREATE INDEX IF NOT EXISTS idx_deals_parent_deal_id ON deals(parent_deal_id);
