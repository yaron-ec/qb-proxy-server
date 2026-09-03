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
  && echo "Runtime file verification PASSED" \
  || (echo "FATAL: Runtime file verification FAILED — critical files missing from Docker image" && exit 1)

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node db/migrate.js && node server.js"]