FROM node:24.20.0-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsdown.config.ts vite.config.ts index.html ./
COPY src ./src
COPY public/favicon.svg ./public/favicon.svg
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:24.20.0-bookworm-slim AS runtime
ARG BUILD=local
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/taskindex.db BUILD=$BUILD
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node drizzle/v2 ./drizzle/v2
COPY --chown=node:node deploy/database.mjs ./deploy/database.mjs
RUN chmod +x dist/cli/index.js dist/cli/admin.js \
    && ln -s /app/dist/cli/index.js /usr/local/bin/taskindex \
    && ln -s /app/dist/cli/admin.js /usr/local/bin/taskindex-admin
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
