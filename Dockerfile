FROM ghcr.io/puppeteer/puppeteer:21.6.1

WORKDIR /app

# IMPORTANT: Set this BEFORE npm install to skip Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
