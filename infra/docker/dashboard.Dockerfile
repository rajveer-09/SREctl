# Cloud Run image for the SREctl console.
#
# Unlike ingest and the orchestrator, this one compiles in the image rather
# than taking a pre-built bundle. `.next` is excluded from the build context
# (see .dockerignore) because it is large and host-specific, and a Next.js
# build is not portable between a Windows host and a Linux container anyway.
#
# Two stages: the builder carries pnpm, the workspace and a full node_modules;
# the runtime carries only Next's standalone output, which is a few megabytes
# of traced files with no package manager and no source.

# ---------------------------------------------------------------- builder ---
FROM node:24-slim AS builder
WORKDIR /repo

RUN corepack enable

# Manifests first, so a source-only change does not re-resolve dependencies.
# Every workspace package is listed: pnpm refuses --frozen-lockfile if a
# member named by pnpm-workspace.yaml has no package.json present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json      apps/dashboard/
COPY apps/ingest/package.json         apps/ingest/
COPY apps/orchestrator/package.json   apps/orchestrator/
COPY packages/core/package.json       packages/core/
COPY packages/agents/package.json     packages/agents/
COPY packages/github/package.json     packages/github/
COPY packages/monitor/package.json    packages/monitor/
COPY packages/retrieval/package.json  packages/retrieval/
COPY packages/sandbox/package.json    packages/sandbox/

RUN pnpm install --frozen-lockfile

# Only what the dashboard compiles against. @srectl/core is TypeScript source
# consumed through transpilePackages, so it is copied as source, not built.
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/dashboard apps/dashboard

# Enables `output: "standalone"`. It is off by default because emitting it
# requires symlinks, which Windows refuses without elevation - see the comment
# in apps/dashboard/next.config.mjs.
ENV NEXT_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @srectl/dashboard exec next build

# ---------------------------------------------------------------- runtime ---
FROM node:24-slim AS runtime
WORKDIR /app

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The standalone tree mirrors the workspace layout because outputFileTracingRoot
# is the repository root: the server lands at apps/dashboard/server.js with a
# shared node_modules beside it.
COPY --from=builder --chown=10001:10001 /repo/apps/dashboard/.next/standalone ./
# Static assets and the compiled CSS are deliberately NOT traced into
# standalone; without this copy the pages render unstyled and every /_next/static
# request 404s.
COPY --from=builder --chown=10001:10001 /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static

USER 10001:10001

# Cloud Run injects PORT and expects the container to listen on it. Next's
# standalone server reads PORT and HOSTNAME; HOSTNAME must be 0.0.0.0, since
# the default binds localhost and the health probe would never connect.
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/dashboard/server.js"]
