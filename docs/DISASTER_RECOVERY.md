# Disaster Recovery — EC Construction Group CRM

## Backup Strategy

### Database (Railway Postgres)

- Railway provides automated daily backups of the Postgres instance
- Backups are retained per Railway's backup policy
- Restore is performed via Railway dashboard (not automated)

### Code (GitHub)

- All production code is in GitHub (yaron-ec/qb-proxy-server)
- Main branch is the canonical source of truth
- No Base44 code is required for production

## Restore Procedure

### Database Restore

1. Access Railway dashboard
2. Select the Postgres service
3. Choose the backup point to restore from
4. Railway provisions a new Postgres instance from the backup
5. Update the `DATABASE_URL` environment variable to point to the new instance
6. Restart qb-proxy-server

**IMPORTANT**: Database restore is a destructive operation that requires explicit authorization. Do NOT perform a restore without approval.

### Code Restore

1. Identify the last known good commit on `main`
2. `git revert <bad-commit>` or `git reset --hard <good-commit>`
3. Push to `main`
4. Railway auto-deploys

## Restore Drill Status

**NOT VERIFIED**

No isolated non-production restore environment exists. A safe restore drill requires:
1. A separate Railway project (non-production)
2. A Postgres instance provisioned from a backup
3. Verification of schema + data integrity
4. No impact on production

This drill has NOT been performed. The restore procedure above is documented for future execution.

## RTO/RPO

- **RPO (Recovery Point Objective)**: 24 hours (Railway daily backups)
- **RTO (Recovery Time Objective)**: 2-4 hours (manual restore via Railway dashboard)

## What Is NOT Covered

- Point-in-time recovery (not available on Railway Postgres)
- Cross-region failover (single Railway region)
- Automated restore testing (no isolated environment)