# syntax=docker/dockerfile:1
# gsm2http all-in-one image: REST API, webhooks and the web UI on one port.
# Build from the repository root:  docker build -t gsm2http .
#
# Node 22 is the newest LTS line with official linux/arm/v7 images
# (Raspberry Pi 2/3 on a 32-bit OS); Node 24 dropped arm/v7.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

# TypeScript and the UI bundle are platform independent: build once on the build host.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY backend backend
COPY frontend frontend
RUN npm run build

# Production dependencies for the target platform (serialport ships glibc
# prebuilds for x64, arm64 and armv7, so no compiler is needed).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace backend --no-audit --no-fund \
 && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9333 \
    STATIC_DIR=/app/public
# Fixed non-root uid that does not collide with the first host user (1000),
# in the dialout group (gid 20 on Debian/Raspberry Pi OS) for /dev/ttyUSB*.
RUN groupadd --system --gid 10001 gsm2http \
 && useradd --system --uid 10001 --gid gsm2http --groups dialout \
      --no-create-home --home-dir /app --shell /usr/sbin/nologin gsm2http
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /src/backend/package.json backend/
COPY --from=build /src/backend/dist backend/dist
COPY --from=build /src/frontend/dist public
USER gsm2http
EXPOSE 9333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||9333)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "backend/dist/index.js"]
