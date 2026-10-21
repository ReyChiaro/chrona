#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ -f .env ]]; then set -a; source .env; set +a; fi
runtime_dir="${CHRONA_RUNTIME_DIR:-${CHRONA_DATA_DIR:-.data}/runtime}"
for service in web render; do
  file="$runtime_dir/$service.pid"
  if [[ -f "$file" ]]; then
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
      for attempt in {1..50}; do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        echo "$service is still shutting down; check $runtime_dir/$service.log"
        exit 1
      fi
    fi
    rm "$file"
    echo "$service stopped"
  fi
done
