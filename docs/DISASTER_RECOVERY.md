# Disaster Recovery — EC Construction Group CRM

**Last verified**: 2026-09-14

## Backup

### Railway Postgres Backups

- **Mechanism**: Railway managed Postgres automatic backups
- **Retention**: Railway default (7 days of daily backups)
- **Verification**: NOT independently verified in this closure — operator should confirm in Railway dashboard
- **Manual backup**: Railway dashboard -> Postgres -> Create Backup

### What is Backed Up

- All production tables (leads, appointments, deals, etc.)
- Integration credentials (encrypted)
- Migration history (schema_migrations)
- Monitoring data (monitoring_incidents, etc.)

## Restore

### Full Database Restore

1. Railway dashboard -> Postgres -> Backups
2. Select backup point
3. Click "Restore" (creates new database instance)
4. Update DATABASE_URL in all services
5. Restart all services

**WARNING**: Never restore over production. Always restore to a new instance, verify, then switch.

### Non-Destructive Restore Validation

- **Status**: NOT VERIFIED in this closure
- **Requirement**: Operator should perform an isolated restore drill on a non-production Postgres instance
- **Procedure**: Restore backup to new instance -> run test queries -> verify data integrity -> delete test instance

## Deployment Rollback

### Railway Rollback

1. Railway dashboard -> qb-proxy-server -> Deployments
2. Select previous successful deployment
3. Click "Deploy" (rolls back to that version)
4. Verify health: GET /health

### GitHub Rollback

1. Identify last known-good commit: git log --oneline -20
2. Revert: git revert <commit-sha> (creates new commit)
3. Push: git push origin main
4. Railway auto-deploys from main

## Migration Recovery

### Failed Migration

1. Check schema_migrations table: SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5
2. If migration is marked applied but failed:
   - Manually fix the database state
   - Delete the migration record: DELETE FROM schema_migrations WHERE filename = '2026-XX-xxx.sql'
   - Re-run: POST /api/v1/cron/apply-migrations
3. If migration is NOT marked applied:
   - Fix the SQL file
   - Re-run: POST /api/v1/cron/apply-migrations

### Missing Migration in Container

**Current issue**: Migration 2026-36-restore-lead-sources.sql is in the repo but NOT in the running container (Docker layer cache served stale image with 35/36 migrations).

**Fix**:
1. Railway dashboard -> qb-proxy-server -> Deploy -> Redeploy with "Clear Build Cache"
2. New build copies db/ directory fresh (36 files)
3. Container startup runs 'node db/migrate.js' which applies the migration
4. Verify: POST /api/v1/cron/apply-migrations -> should show "1 applied, 36 total"

## Credential Recovery

### JWT Secret

- If JWT_SECRET is lost: all user sessions invalidated. Users must re-login.
- Generate new: openssl rand -hex 32
- Update in Railway env vars for all services

### Integration OAuth Tokens

- Stored in integration_credentials table (encrypted)
- If encryption key lost: all tokens must be re-authenticated
- If database restored: tokens are restored with it

### Worker Secret

- If WORKER_SECRET is lost: cron endpoints inaccessible
- Generate new: openssl rand -hex 32
- Update in Railway env vars for all services

## Recovery Boundaries

| Action | Safe? | Requires Approval? |
|--------|-------|-------------------|
| Restart service | Yes | No |
| Redeploy with cache clear | Yes | No |
| Rollback deployment | Yes | No |
| Restore backup to new instance | Yes | No |
| Restore backup over production | NO | YES |
| Delete production data | NO | YES |
| Rotate credentials | Yes (with care) | Notify users |
| Change Railway topology | NO | YES |
