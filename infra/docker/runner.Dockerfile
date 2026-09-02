# The sandbox runner image.
#
# Deliberately boring: a stock Node base, a non-root user, and the wrapper.
# No shell tooling, no git, no curl. Anything not present cannot be abused by
# code the agent generated, and the image is small enough that Phase 3's prep
# artifact cache stays cheap.

FROM node:24-slim

# procps only. Stryker's child-process supervision shells out to `ps` to walk
# the process tree, and without it the whole mutation run dies with
# "spawn ps ENOENT" before a single mutant is scored. Everything else stays
# out of the image: no git, no curl, no package managers beyond npm.
RUN apt-get update  && apt-get install -y --no-install-recommends procps  && rm -rf /var/lib/apt/lists/*

# Fixed uid/gid so the Kubernetes securityContext in Phase 3 can pin the same
# numbers without depending on how the image happens to resolve names.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/runner runner

# Every writable location is declared here rather than discovered one EPERM at
# a time once the root filesystem is read-only.
ENV HOME=/home/runner \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    CI=true \
    NODE_ENV=test

COPY --chown=10001:10001 packages/sandbox/src/wrapper/ /opt/srectl/

WORKDIR /workspace
USER 10001:10001

# The wrapper is the only entry point. It runs the test command it is given,
# and prints a structured envelope between sentinels.
ENTRYPOINT ["node", "/opt/srectl/run.mjs"]
