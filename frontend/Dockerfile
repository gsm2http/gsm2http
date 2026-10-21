# syntax=docker/dockerfile:1
# gsm2http web UI on nginx (non-root). Serves the SPA and proxies /api and /socket.io to
# the backend, so the browser only ever talks to one origin and the same image works for
# any deployment. Build from the repository root:
#   docker build -f frontend/Dockerfile -t gsm2http-web .
# Configure at runtime:
#   BACKEND_URL  where the backend listens (default http://backend:9333)
#   LISTEN_PORT  port nginx listens on inside the container (default 8080)
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.2-alpine

# Static assets are platform independent: build once on the build host.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --no-audit --no-fund
COPY frontend frontend
RUN npm run build --workspace frontend

FROM ${NGINX_IMAGE}
ENV BACKEND_URL=http://backend:9333 \
    LISTEN_PORT=8080
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${LISTEN_PORT}/nginx-health" || exit 1
