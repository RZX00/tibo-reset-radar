# One image, one process: migrations, API, static page and the collector loop.
FROM node:24.11.1-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY db ./db
COPY config ./config
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.11.1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/db ./db
COPY --from=build /app/config ./config
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune
ENV RADAR_DB_PATH=/data/radar.db \
    RADAR_MIGRATIONS_DIR=/app/db/migrations \
    RADAR_SITE_ROOT=/app/apps/web/dist \
    HOST=0.0.0.0 \
    PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "apps/api/dist/main.js"]
