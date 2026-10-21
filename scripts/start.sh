#!/usr/bin/env bash
# Start gsm2http without Docker. Reads ./.env from the repository root and
# serves the web UI from frontend/dist when it has been built.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f backend/dist/index.js ]; then
  echo "backend/dist/index.js not found; run scripts/build.sh first" >&2
  exit 1
fi

if [ -z "${STATIC_DIR+x}" ] && [ -f frontend/dist/index.html ]; then
  export STATIC_DIR="$ROOT/frontend/dist"
fi
export NODE_ENV="${NODE_ENV:-production}"

exec node backend/dist/index.js
