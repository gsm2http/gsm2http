#!/usr/bin/env bash
# Build gsm2http for running without Docker.
#   backend -> backend/dist   (compiled with tsc; run with plain node)
#   web UI  -> frontend/dist  (static files, served by the backend)
#
# Options:
#   --no-ui   skip the web UI (e.g. copy a frontend/dist built on another
#             machine; the files are platform independent)
#   --prune   drop dev dependencies after building (smaller install; run this
#             script again without it before `npm test` or `npm run dev:backend`)
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_UI=1
PRUNE=0
for arg in "$@"; do
  case "$arg" in
    --no-ui) BUILD_UI=0 ;;
    --prune) PRUNE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

node -e 'const [maj, min] = process.versions.node.split(".").map(Number); if (maj < 20 || (maj === 20 && min < 19)) { console.error(`Node.js >= 20.19 required (found ${process.version}); Node 22 LTS recommended`); process.exit(1); }'

echo "==> Installing dependencies"
npm ci --no-audit --no-fund

echo "==> Building backend"
npm run build --workspace backend

if [ "$BUILD_UI" = 1 ]; then
  echo "==> Building web UI"
  npm run build --workspace frontend
fi

if [ "$PRUNE" = 1 ]; then npm prune --omit=dev --no-audit --no-fund; fi

echo "==> Done. Start with: scripts/start.sh"
