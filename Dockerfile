# Railway rebuild trigger 2026-09-02: deals uuid cast fix
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
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]