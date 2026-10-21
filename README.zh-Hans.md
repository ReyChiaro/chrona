# ⏳ Chrona

[English](README.md) · 简体中文

Chrona 提供可保存的过程生成世界、物理模拟、可撤销场景编辑、区域内容、参考录制和视频生成。界面支持英文与简体中文。

## 安装与运行

需要 Node.js 22.12+、uv、Python 3.12、FFmpeg 和 ffprobe。

```sh
npm ci
uv sync --frozen --group dev
cp .env.example .env
npm run build
bash scripts/start.sh
```

按部署环境设置 `.env`。渲染和编写配置使用 `CHRONA_` 前缀。场景编辑必须启用并配置 `CHRONA_AGENT_BASE_URL`、`CHRONA_AGENT_MODEL` 及所需凭据；未配置时明确报错，没有离线配方生成器。

不配置视频模型仍可探索世界。GPU 推理为可选安装：

```sh
UV_PROJECT_ENVIRONMENT=.venv-inference uv sync --frozen --extra inference --group dev
```

本地模型通过 `CHRONA_MODEL_PATH` 配置，也可显式配置 HTTP 推理后端。模型、私密设置、生成数据和内部报告不纳入版本管理。

## 验证

```sh
npm run check
npm run test:browser
uv run --frozen --group dev pytest -q
```

浏览器测试需要 Chromium 或 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。测试适配器和配方只位于测试目录，常规测试不调用外部模型 API。

## 接口与存档

浏览器入口为 `window.chrona`，视频接口为 `/api/render/jobs`。配方使用命名材质；区域地形使用协议 2，对象配方仍使用协议 1。恢复世界要求完整物理检查点及匹配的引擎版本和构建。不支持的旧格式会明确拒绝，不自动迁移。
