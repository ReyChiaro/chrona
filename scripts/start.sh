#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
export PATH="$project_dir/.tools/node/bin:$HOME/.local/bin:$PATH"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
runtime_dir="${CHRONA_RUNTIME_DIR:-${CHRONA_DATA_DIR:-.data}/runtime}"
export CHRONA_DATA_DIR="${CHRONA_DATA_DIR:-${CHRONA_DATA_DIR:-.data}/render}"
mkdir -p "$runtime_dir"
if [[ ! -f dist/index.html ]]; then npm run build; fi
start_process() {
  local service="$1"; shift
  local pid_file="$runtime_dir/$service.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$service already running"
    return
  fi
  nohup setsid "$@" >>"$runtime_dir/$service.log" 2>&1 </dev/null &
  echo "$!" >"$pid_file"
  echo "$service started"
}
start_process render uv run --frozen --no-sync uvicorn chrona.api.app:create_app --factory --host 127.0.0.1 --port "${RENDER_PORT:-8090}"
start_process web node --import tsx apps/api/src/index.ts --production
echo "Web: http://${HOST:-127.0.0.1}:${PORT:-4173}"
