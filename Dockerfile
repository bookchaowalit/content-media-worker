# syntax=docker/dockerfile:1
# Portable media worker. Build from the infra/ directory so the shared router
# and routing registry are in the context:
#   docker build -f media-worker/Dockerfile infra
# Runs on any container host: Railway, Render, Fly, Azure Container Apps,
# Google Cloud Run (with `once` + Cloud Scheduler), or a VM.

FROM node:22-slim AS build
WORKDIR /build/media-worker
COPY media-worker/package.json media-worker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/media_router.ts /build/api/
COPY platform/media-transcription-routing.json /build/platform/
COPY media-worker/ ./
RUN npm run build:node

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    MEDIA_STATE=upstash \
    MEDIA_SINK=onedrive
WORKDIR /app
COPY --from=build /build/media-worker/dist/node.mjs ./node.mjs
USER node
CMD ["node", "node.mjs", "loop"]
