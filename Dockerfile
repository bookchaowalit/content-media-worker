# syntax=docker/dockerfile:1
# Portable media worker. Build from the repository root:
#   docker build -t solo-media-worker .
# Runs on any container host: Railway, Render, Fly, Azure Container Apps,
# Google Cloud Run (with `once` + Cloud Scheduler), or a VM.

FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build:node

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    MEDIA_STATE=upstash \
    MEDIA_SINK=onedrive
WORKDIR /app
COPY --from=build /build/dist/node.mjs ./node.mjs
# Image hardening: take Debian security fixes newer than the base tag, and drop npm, npx and
# corepack, which the runtime never calls (their bundled dependencies are what Trivy flags).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
CMD ["node", "node.mjs", "loop"]
