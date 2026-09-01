#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

if [ ! -x .venv/bin/uvicorn ]; then
  echo "Dashboard is not set up yet. Run ./setup.sh first."
  exit 1
fi

# Keep the trusted-LAN bundle separate from the password-protected Vercel bundle.
# Rebuilding on every manual start prevents an old production bundle from leaving
# localhost stuck behind a Turnstile widget that is intentionally not configured.
npm run build -- --mode lan --outDir dist-local

STATIC_DIR="$PROJECT_DIR/web/dist-local"
export STATIC_DIR

set --
if [ -f .env ]; then
  set -- --env-file "$PROJECT_DIR/.env"
fi

exec .venv/bin/uvicorn goodwe_home.main:app --host 0.0.0.0 --port "${PORT:-8080}" "$@"
