# The digest pins the multi-platform Node 24 base artifact.
FROM node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.22.0 --ignore-scripts
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build && pnpm --filter @navis/api deploy --prod --legacy /runtime \
    && node --input-type=module -e "import { isolateDeploymentFiles } from './scripts/package-deployment.mjs'; isolateDeploymentFiles('/runtime');"

FROM node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS runtime
ARG NAVIS_REVISION=development
LABEL org.opencontainers.image.title="Navis API" org.opencontainers.image.revision=$NAVIS_REVISION
ENV NODE_ENV=production NAVIS_API_HOST=0.0.0.0 NAVIS_API_PORT=8080
ENV DATABASE_URL_FILE=/run/navis/database-url NAVIS_MODEL_API_KEY_FILE=/run/navis/model-key
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
COPY scripts/container/api-entrypoint.mjs /app/container/api-entrypoint.mjs
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:8080/readyz', { signal: AbortSignal.timeout(3000) }); if (!r.ok) process.exit(1);"
ENTRYPOINT ["node", "/app/container/api-entrypoint.mjs"]
