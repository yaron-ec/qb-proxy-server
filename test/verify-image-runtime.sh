#!/bin/sh
# Runtime-image verification — run AFTER: docker build -t qb-proxy-email-minimal .
set -e
docker run --rm --entrypoint sh qb-proxy-email-minimal -c '
  test -f /app/server.js &&
  test -d /app/lib && test -d /app/routes && test -d /app/db &&
  test -f /app/routes/auth.js && test -f /app/routes/emails.js && test -f /app/routes/gmail.js &&
  test -f /app/reminderWorker.js
'
echo "runtime image verification OK"
