FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy package files
COPY package.json ./

# Install Node dependencies
RUN npm install

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium

# Copy the rest of the app
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]