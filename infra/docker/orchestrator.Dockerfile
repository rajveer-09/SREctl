# In-cluster image for the orchestrator.
#
# Runs as a Deployment inside the cluster rather than on Cloud Run, so it gets
# a ServiceAccount and in-cluster Kubernetes config for free. Reaching a
# private GKE control plane from Cloud Run would need Direct VPC egress, a
# connector and extra IAM - a lot of networking surface for no benefit.

FROM node:24-slim
WORKDIR /app

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app

COPY dist/orchestrator/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=10001:10001 dist/orchestrator/ ./

USER 10001:10001
ENV NODE_ENV=production
CMD ["node", "index.js"]
