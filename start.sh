#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

if [ ! -x .venv/bin/uvicorn ]; then
  echo "Dashboard is not set up yet. Run ./setup.sh first."
  exit 1
fi

if [ ! -f dist/index.html ]; then
  npm run build
fi

exec .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8080}"
