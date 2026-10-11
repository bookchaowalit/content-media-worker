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
USER node
CMD ["node", "node.mjs", "loop"]
