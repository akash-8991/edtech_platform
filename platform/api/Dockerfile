# Multi-stage, non-root, runtime image without dev dependencies or the Prisma CLI.
FROM node:22-bookworm-slim AS build
# Prisma needs OpenSSL to pick its engine; ca-certificates for outbound TLS (AI providers, S3, IdP)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production UV_THREADPOOL_SIZE=8 PORT=3000 MEDIA_ROOT=/data/media
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# runtime deps only; the generated Prisma client is copied from the build stage (the CLI is not shipped)
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
# writable media directory for STORAGE_DRIVER=local (single-host / compose); production uses S3 and never writes here
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]

# ---- worker: the runtime image plus ffmpeg, which builds the adaptive-bitrate ladder (FFMPEG_BIN / FFPROBE_BIN default to the PATH) -------------------------
FROM runtime AS worker
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "dist/src/worker.js"]

# ---- grader: the worker plus the Docker CLI, used ONLY against the socket proxy (DOCKER_HOST=tcp://docker-proxy:2375), never a raw socket ------------------------
FROM docker:27-cli AS dockercli
FROM worker AS grader
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
CMD ["node", "dist/src/worker.js"]
