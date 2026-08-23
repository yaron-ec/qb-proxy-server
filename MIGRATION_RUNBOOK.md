# MIGRATION RUNBOOK — Base44 → Railway Data Import

> **PREREQUISITE:** Railway redeployment with all 14 migration files.
> The current container only has 10 migrations (2026-07 through 2026-13).
> Migrations 2026-14 through 2026-17 are in the repo but NOT in the container.
> A new deployment must be triggered before running any import scripts.

---

## STEP 1: Apply Missing Migrations (BLOCKED — requires operator action)

```bash
# On Railway, after redeployment:
node db/migrate.js
```

**Expected output:** "all migrations applied (14 file(s))" — not 10.

**Verify:**
```sql
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';
-- Should show ~35 tables (was ~20 before 2026-14/15/16/17)
```

---

## STEP 2: Import Data (in dependency order)

### Phase A — Tables that already exist (can run NOW after STEP 1)

| Order | Script | Dataset | Base44 Count | Depends On |
|-------|--------|---------|-------------|------------|
| 1 | `migrateLeadsToRailway.js` | Leads | 1,064 | Owners (seeded) |
| 2 | `migrateActivitiesToRailway.js` | Activities | 5,000+ | Leads |
| 3 | `migrateDealsToRailway.js` | Deals | 45 | Leads |

```bash
# Run in order on Railway:
node scripts/migrateLeadsToRailway.js
node scripts/migrateActivitiesToRailway.js
node scripts/migrateDealsToRailway.js
```

**Verify after Phase A:**
```sql
SELECT 'leads' as t, COUNT(*) FROM leads
UNION ALL SELECT 'activities', COUNT(*) FROM activities
UNION ALL SELECT 'deals', COUNT(*) FROM deals;
-- Expected: leads=1064, activities=5000+, deals=45
```

### Phase B — Tables created by migration 2026-14 (run after STEP 1)

| Order | Script | Dataset | Base44 Count | Depends On |
|-------|--------|---------|-------------|------------|
| 4 | `migratePropertiesToRailway.js` | Properties | 133 | Leads |
| 5 | `migrateHandoffEstimatesToRailway.js` | Handoff Estimates | 164 | Leads |
| 6 | `migrateSmallDatasetsToRailway.js` | UserAllowlist + CompanySettings + SyncCursors + LeadAttachments + DealExpenses | 5+1+5+7+31 | Leads, Deals |

```bash
node scripts/migratePropertiesToRailway.js
node scripts/migrateHandoffEstimatesToRailway.js
node scripts/migrateSmallDatasetsToRailway.js
```

**Verify after Phase B:**
```sql
SELECT 'properties' as t, COUNT(*) FROM properties
UNION ALL SELECT 'handoff_estimates', COUNT(*) FROM handoff_estimates
UNION ALL SELECT 'user_allowlist', COUNT(*) FROM user_allowlist
UNION ALL SELECT 'company_settings', COUNT(*) FROM company_settings
UNION ALL SELECT 'sync_cursors', COUNT(*) FROM sync_cursors
UNION ALL SELECT 'lead_attachments', COUNT(*) FROM lead_attachments
UNION ALL SELECT 'deal_expenses', COUNT(*) FROM deal_expenses;
```

---

## STEP 3: Switch REMINDER_SOURCE to postgres (ONLY after STEP 2 verified)

```bash
# On Railway, set environment variable:
REMINDER_SOURCE=postgres
```

**Pre-conditions (ALL must be met):**
- [ ] `SELECT COUNT(*) FROM leads` returns ~1,064
- [ ] `reminder_leads` table populated (via upsert endpoint or importer)
- [ ] No duplicate sender risk verified
- [ ] Test reminder sent successfully from Railway source

---

## SAFETY GUARANTEES

| Property | Value |
|----------|-------|
| Idempotent | YES — all scripts use ON CONFLICT DO UPDATE |
| Safe to re-run | YES — no duplicates created |
| Can create duplicates | NO — external_ref / legacy_base44_id UNIQUE |
| Can overwrite data | PARTIALLY — COALESCE preserves existing non-null values |
| Can delete data | NO — one-way import, no deletions |
| Reversible | YES — `DELETE FROM <table> WHERE external_ref IS NOT NULL` clears imports |

---

## DATASETS NOT YET COVERED BY IMPORT SCRIPTS

| Dataset | Base44 Count | Import Script | Status |
|---------|-------------|---------------|--------|
| QBSyncJob | 4,328 | NOT NEEDED — historical audit data, Railway creates its own | SKIP |
| DealCommission | 0 | N/A — no data to import | SKIP |
| DealLoanPayment | 0 | N/A — no data to import | SKIP |
| SmsReminder | 0 | N/A — no data to import | SKIP |
| SmsLog | 0 | N/A — no data to import | SKIP |
| QBConnection | 0 | N/A — tokens stored in integration_credentials table | SKIP |
| DealExpensePayment | unknown | NOT YET CREATED | TODO |
| Estimate | unknown | NOT YET CREATED | TODO |
| Task | 1 | NOT YET CREATED | TODO |
| Invoice | 1 | NOT YET CREATED | TODO |
| SignNowDocument | unknown | NOT YET CREATED | TODO |

**NOTE:** QBSyncJob (4,328 records) is historical audit data. Railway creates its own QBSyncJob records going forward. Importing historical audit data is NOT required for production functionality.