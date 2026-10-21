# ⏳ Chrona

[English](README.md) · [简体中文](README.zh-Hans.md)

Chrona is a persistent world workspace driven by user intent. The World Engine owns geometry, objects, physics and world time. Content recipes describe reversible edits. The renderer turns immutable camera recordings into video without resetting the world.

The four views provide a 3D overview, exploration map, first-person proxy and generated video, with conversation editing, materials, native water, regional scenes, moving vehicles, reference images, recording and task logs.

## Languages

English is the default. Choose **English** or **简体中文** in the top bar; your choice is remembered and changes the interface without reloading the world. `?lang=en` and `?lang=zh-Hans` override the saved preference. Unsupported languages fall back to English. Japanese (`ja`) and Traditional Chinese (`zh-Hant`) are reserved in [the locale registry](locales/registry.json) and remain hidden until complete translations are available.

Shared catalogs in `locales/` own interface text, errors, progress and parameter labels. User names, instructions, conversation history, saved recipes and historical evidence retain their original text. See [language maintenance](docs/I18N.md).

## Install and run

Requires Node.js 22.12+, uv, Python 3.12 and FFmpeg / ffprobe. The ignored `.tools/node/` directory may contain the project's Node runtime.

```sh
npm ci
uv sync --frozen --group dev
npm run build
```

Copy `.env.example` to `.env`, then explicitly configure ports, service addresses, data directories and optional model resources. Do not implicitly reuse another project's data directory.

```sh
bash scripts/start.sh
bash scripts/stop.sh
```

For development, run `npm run dev` and `uv run --frozen --no-sync uvicorn chrona.api.app:create_app --factory --host 127.0.0.1 --port 8090` separately. The world and built-in content demos work without video weights. GPU inference is optional:

```sh
UV_PROJECT_ENVIRONMENT=.venv-inference uv sync --frozen --extra inference --group dev
```

Use that environment when starting an inference provider. Configure models and credentials explicitly; failures never silently switch an actual API request to demo output. See [deployment](docs/DEPLOYMENT.md) and [usage](docs/USAGE.md).

## Modules

| Location | Responsibility |
| --- | --- |
| `contracts/schemas/` | Canonical configuration, persistence, content, recording and rendering contracts |
| `packages/protocol/`, `src/chrona/protocol/` | Generated TypeScript exports and Python adapters |
| `packages/world/` | Deterministic PCG, domain state, clock, content transactions and ports |
| `packages/adapters/` | Rapier execution, Worker transport and world storage |
| `packages/proxy/`, `src/chrona/authoring/` | Recipe compilation, validation and bounded Agent workflows |
| `packages/viewer/`, `apps/web/` | Three.js, maps, exploration, editing and recording |
| `packages/i18n/`, `locales/` | Language policy, shared catalogs, formatting and presentation bindings |
| `apps/api/` | Node HTTP API, persistence, publication and service forwarding |
| `src/chrona/rendering/` | Recorded context, prompts, route segmentation, retries and tasks |
| `harness/` | Separate authoring and video-conditioning instructions |
| `report/` | Bilingual report with preserved source media and evidence |

Read the [architecture](docs/ARCHITECTURE.md) and [compatibility rules](contracts/compatibility/README.md) before changing engine or save semantics.

## Validate

```sh
npm run check
npm run test:browser
uv run --frozen --group dev pytest -q
```

Browser checks require Chromium or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Existing UI scenarios cover Simplified Chinese; the i18n suite starts with fresh storage and checks English defaults, live switching, Worker errors, English demo commands, recording continuity and the report. Tests use isolated data and explicit test providers.

`npm run generate:protocol` refreshes protocol artifacts. `npm run check:i18n` checks catalog parity, interpolation arguments, references and hardcoded UI text. Python wheels include the same locale resources.

## Existing data and report

`scripts/import-data.py` inspects selected data and is a dry run unless `--apply` is supplied; conflicts preserve both sides. Credentials and Agent settings are not imported. See [migration](docs/MIGRATION.md).

Production builds include `/report/`. For a source preview, run `python3 -m http.server 4178` from the repository root and open `/report/`; shared catalogs are under `/locales/`. Original evidence JSON, model prompts, screenshots and videos remain unchanged and may contain original-language text. Historical Chinese technical notes are retained under `docs/zh-Hans/`.
