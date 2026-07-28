#!/bin/sh
# Runtime-image verification — run AFTER: docker build -t qb-proxy-email-review .
# Verifies required runtime files exist in the image WITHOUT starting prod.
set -e
docker run --rm --entrypoint sh qb-proxy-email-review -c '
  test -f /app/server.js &&
  test -f /app/package.json &&
  test -f /app/package-lock.json &&
  test -d /app/lib &&
  test -d /app/routes &&
  test -f /app/routes/auth.js &&
  test -f /app/routes/emails.js &&
  test -f /app/routes/gmail.js &&
  test -d /app/db &&
  test -f /app/reminderWorker.js &&
  test -f /app/reminderWatchdog.js &&
  test -f /app/validateEmailMigration.js
'
echo "runtime image verification OK"
