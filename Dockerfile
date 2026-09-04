# WAR ARENA â€” production image.
# Multi-stage: build TypeScript, then run a slim runtime. gmgn-cli is installed
# globally so the live executor can spawn it.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Install gmgn-cli globally (the live transport binary). ALL live data flows
# through this binary, so a failed install must FAIL THE BUILD â€” never ship a
# server that boots but can never fetch a token. Pinned for reproducibility.
RUN npm install -g gmgn-cli@1.5.9
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# Non-root for safety.
USER node
EXPOSE 8080
# NOTE: no in-container HEALTHCHECK. Koyeb probes GET /health from its own
# health-check config; a 30s internal probe would keep the container awake and
# defeat scale-to-zero. Configure the health path as /health in the Koyeb panel.
CMD ["node", "dist/src/deploy/server.js"]
