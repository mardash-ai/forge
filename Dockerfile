# Forge CONTROL PLANE image  →  ghcr.io/mardash-ai/forge-control-plane
#
# This is the developer/orchestration runtime: the Forge platform + the Docker
# CLI, so Capabilities can drive `docker compose` for Builder applications
# (Docker-out-of-Docker). It carries developer dependencies on purpose.
#
# It is DELIBERATELY SEPARATE from the future Forge DATA PLANE image (the
# production/deploy runtime), which must stay slim and must NOT include these
# developer dependencies or the Docker CLI.
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Forge Control Plane"
LABEL org.opencontainers.image.description="Forge developer/orchestration runtime (control plane). Not for production data-plane use."
LABEL com.mardash-ai.plane="control"

# Docker CLI + Compose plugin, so the platform can run app builds/tests in Docker.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /forge

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests

EXPOSE 3717
CMD ["./node_modules/.bin/tsx", "src/api/server.ts"]
