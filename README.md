# ⏳ Chrona

[English](README.md) · [简体中文](README.zh-Hans.md)

Chrona is a persistent procedural world with reversible scene editing, regional content, physics, reference recording and video generation. The interface supports English and Simplified Chinese.

## Install and run

Requires Node.js 22.12+, uv, Python 3.12, FFmpeg and ffprobe.

```sh
npm ci
uv sync --frozen --group dev
cp .env.example .env
npm run build
bash scripts/start.sh
```

Configure `.env` for your deployment. Rendering and authoring settings use the `CHRONA_` prefix. Set `CHRONA_AGENT_BASE_URL` and `CHRONA_AGENT_MODEL`, enable the code agent and configure credentials if required. Scene editing reports a configuration error until a model is ready; there is no offline content generator.

For development, run `npm run dev` and `uv run --frozen --no-sync uvicorn chrona.api.app:create_app --factory --host 127.0.0.1 --port 8090` separately. The world can be explored without a video model. GPU inference is optional:

```sh
UV_PROJECT_ENVIRONMENT=.venv-inference uv sync --frozen --extra inference --group dev
```

Configure `CHRONA_MODEL_PATH` for local model weights or select an explicitly configured HTTP provider. Model weights, private settings, generated data and internal reports are excluded from version control.

## Validate

```sh
npm run check
npm run test:browser
uv run --frozen --group dev pytest -q
```

Browser tests require Chromium or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Test adapters and fixtures are confined to tests. No external model API is called by the normal test suite.

## Interfaces and persistence

`window.chrona` exposes the browser adapter. The video API uses `/api/render/jobs`. Content uses named materials; regional terrain requires protocol 2. Protocol 1 is retained for current object-only recipes. World restoration requires a complete physics checkpoint with the same engine version and build. Unsupported old formats are rejected rather than migrated.
