#!/usr/bin/env bash
# Start a real local FalkorDB, then run the disposable SDK demonstration.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24')" != true ]]; then
  echo 'Use Node 24 or newer before running this demo.' >&2
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ -z "${FALKORDB_URL:-}" ]]; then
  docker compose --env-file /dev/null -f docker-compose.yml up --wait falkordb
  export FALKORDB_URL="redis://127.0.0.1:${FALKORDB_PORT:-6379}"
fi
# No .env loading, coding jobs, external API accounts or public listener.
exec node --import tsx scripts/demo.ts
