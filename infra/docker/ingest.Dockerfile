# Cloud Run image for the webhook receiver.
#
# Ingest exists to answer GitHub inside its ~10s delivery timeout: verify the
# HMAC, deduplicate, publish, return. It does no agent work, so it stays small
# and starts fast - a cold start counts against that same budget.
#
# Takes a pre-built bundle from `pnpm build:apps` rather than compiling here,
# so the image contains no toolchain and no source.

FROM node:24-slim
WORKDIR /app

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app

COPY dist/ingest/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=10001:10001 dist/ingest/ ./

USER 10001:10001
ENV NODE_ENV=production
# Cloud Run injects PORT. The config schema reads it.
EXPOSE 8080
CMD ["node", "index.js"]
