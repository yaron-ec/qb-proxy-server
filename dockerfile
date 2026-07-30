FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY reminderWorker.js validateEmailMigration.js ./
COPY lib ./lib
COPY routes ./routes
COPY db ./db
COPY test ./test
EXPOSE 3000
CMD ["node", "server.js"]
