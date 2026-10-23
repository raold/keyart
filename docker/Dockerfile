# syntax=docker/dockerfile:1
#
# Keyart - web UI served in the browser.
#
#   http://<host>:3939  - full app in your browser
#
#   docker build -f docker/Dockerfile -t keyart .

# ----- Dependencies ------------------------------------------------------------
# Only package*.json feeds this stage, so source edits never reinstall.
FROM node:22-bookworm AS deps
WORKDIR /build

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# ----- Browser -----------------------------------------------------------------
# Bundle the Chromium headless shell so the container never downloads it at runtime.
# Only the fetch script is copied, so source edits keep this large download cached.
FROM deps AS browser

COPY scripts/fetch-browser.mjs scripts/fetch-browser.mjs
RUN npm run prepare:browser

# ----- Build stage -------------------------------------------------------------
FROM deps AS build

COPY . .
RUN npm run build:web

RUN npm prune --omit=dev

# ----- Runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
      fonts-liberation \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Largest and most stable layer first.
COPY --from=browser /build/resources/browsers ./resources/browsers
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/server/dist ./server/dist
COPY --from=build /build/src/dist ./src/dist

ENV PLEX_HELPER_WEB=1 \
    PLEX_HELPER_PROD=1 \
    PLEX_HELPER_DOCKER=1 \
    PLEX_HELPER_CONFIG_DIR=/config/app \
    PLEX_BROWSER_BUNDLED_DIR=/app/resources/browsers \
    PORT=3939

# The commit this image was built from, reported by /api/health.
ARG KEYART_COMMIT=dev
ENV KEYART_COMMIT=$KEYART_COMMIT

VOLUME /config
EXPOSE 3939

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3939)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/server/index.js"]
