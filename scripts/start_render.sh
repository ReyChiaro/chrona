cd /root/intern-xr/chrona_workspace/chrona

export PATH="$PWD/.tools/node/bin:$HOME/.local/bin:$PATH"

set -a
source .env
set +a

export CHRONA_RENDER_DATA_DIR="${CHRONA_RENDER_DATA_DIR:-${CHRONA_DATA_DIR:-.data}/render}"

npm run build

uv run --frozen --no-sync \
  uvicorn chrona.api.app:create_app \
  --factory \
  --host 127.0.0.1 \
  --port "${RENDER_PORT:-8090}"