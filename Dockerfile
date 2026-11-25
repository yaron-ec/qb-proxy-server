# P0 recovery redeploy trigger — clear exhausted DB connections
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY reminderWorker.js reminderWatchdog.js productionWatchdog.js ./
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
COPY routes ./routes

# lib/dealFinancialAggregation.js#computeMasterFinancials dynamically
# imports crm-frontend/src/lib/financialCalc.js (a self-contained ESM
# module, no React/browser dependency) so the Master Project financial
# summary never drifts from a single deal's own Financials tab math. This
# backend image otherwise never copies crm-frontend/ at all — without
# these two files, that dynamic import throws MODULE_NOT_FOUND, is caught
# by routes/deals.js's own try/catch, and silently degrades the Master
# Project Contract Total / Projected Profit to a single deal's own figures
# (production incident, November 2026: confirmed root cause of the Lalani
# Master Project Financial Summary showing the wrong Contract Total /
# Projected Profit while the simple-arithmetic combined-contract figure,
# computed separately, stayed correct). crm-frontend/package.json
# (type: module) MUST also be copied — without it, Node's ESM loader
# walks up to the root package.json (no "type" field, defaults to
# commonjs) and throws a SyntaxError parsing financialCalc.js's `export`
# statements instead of loading it.
COPY crm-frontend/package.json ./crm-frontend/package.json
COPY crm-frontend/src/lib/financialCalc.js ./crm-frontend/src/lib/financialCalc.js

# ── Runtime file verification ──────────────────────────────────────────────
# Fails the build if any critical runtime file is missing from the image.
# This catches Docker layer caching issues and build context mismatches.
RUN test -f /app/lib/qbMatch.js \
  && test -f /app/lib/authService.js \
  && test -f /app/lib/emailService.js \
  && test -f /app/lib/reminderEngine.js \
  && test -f /app/lib/railwayDataAccess.js \
  && test -f /app/lib/qbTokenStore.js \
  && test -f /app/lib/qbInvoiceSaleMap.js \
  && test -f /app/lib/reminderRouter.js \
  && test -f /app/lib/actionRouter.js \
  && test -f /app/lib/leadIngestRouter.js \
  && test -f /app/lib/gmailOAuthRouter.js \
  && test -f /app/lib/crmRepository.js \
  && test -f /app/lib/rbac.js \
  && test -f /app/routes/leads.js \
  && test -f /app/routes/deals.js \
  && test -f /app/routes/auth.js \
  && test -f /app/routes/bookings.js \
  && test -f /app/routes/emails.js \
  && test -f /app/routes/activities.js \
  && test -f /app/routes/invoices.js \
  && test -f /app/routes/tasks.js \
  && test -f /app/routes/publicCapture.js \
  && test -f /app/db/client.js \
  && test -f /app/crm-frontend/package.json \
  && test -f /app/crm-frontend/src/lib/financialCalc.js \
  && echo "Runtime file verification PASSED" \
  || (echo "FATAL: Runtime file verification FAILED — critical files missing from Docker image" && exit 1)

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node db/migrate.js && node server.js"]