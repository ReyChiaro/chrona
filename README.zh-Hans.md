# ⏳ Chrona

[English](README.md) · 简体中文

界面默认使用英文，可在顶部切换简体中文；选择会保留，切换不重建世界。支持 `?lang=en` 和 `?lang=zh-Hans`。日语与繁体中文已预留，翻译完成前不显示。语言规范见 [I18N](docs/I18N.md)。

由用户意图驱动、可保存与回访的世界工作台。World Engine 维护几何、对象、物理与世界时间；Proxy Engine 编写内容并输出代理描述；Renderer 把不可变录制转成视频。网页保留四视图、漫游、地图与全景、右键拾取、Enter 对话、编辑撤销、材质、水域、区域、车辆、参考绑定、录制和任务日志。

这是从 Dynamic World 当前工作区迁移的独立正式仓库。原项目、存档、模型及原服务不作为本项目运行依赖。目录映射与源码摘要见 [迁移记录](docs/zh-Hans/MIGRATION.md)，模块职责见 [架构](docs/zh-Hans/ARCHITECTURE.md)，实际检查结果见 [验证记录](docs/zh-Hans/REFACTOR_VALIDATION.md)。

## 安装与运行

需要 Node.js 22.12+、uv、Python 3.12 和 FFmpeg / ffprobe。项目可以使用系统 Node，或自行安装在被忽略的 `.tools/node/`。Node 与 Python 各自使用锁文件。

```sh
npm ci
uv sync --frozen --group dev
npm run build
```

复制 `.env.example` 为 `.env`，按环境设置监听地址、数据目录、服务地址和模型路径。不要覆盖已有服务的端口。

```sh
bash scripts/start.sh
bash scripts/stop.sh
```

也可分别运行：

```sh
npm run dev
uv run --frozen --no-sync uvicorn chrona.api.app:create_app --factory --host 127.0.0.1 --port 8090
```

未配置视频模型仍可使用世界与内容演示。默认不预加载模型，也不安装 GPU 依赖。独立 CPU Authoring API：

```sh
uv run --frozen --no-sync uvicorn chrona.api.authoring:create_app --factory --host 127.0.0.1 --port 8091
```

将 `AUTHORING_SERVICE_URL` 指向它；留空则使用组合 API。API 配置与原演示模式、访问控制继续保留。实际 API 调用失败会报告失败，不会伪装成演示成功。

本地 GPU 推理为可选安装，可使用独立环境：

```sh
UV_PROJECT_ENVIRONMENT=.venv-inference uv sync --frozen --extra inference --group dev
```

启动时设置同一个 `UV_PROJECT_ENVIRONMENT`，或使用该环境的 Python。`DW_PROVIDER` / `DW_VIDEO_PROVIDER` 选择后端，`DW_MODEL_PATH`、`DW_LORA_DIR`、`DW_DEVICE` 等注入资源。通用 HTTP 后端可连接独立推理服务；没有配置的推理引擎不会被宣称可用。默认 MiniMax-H3 流程保留 30 步默认值和可调 LoRA，参数由 `configs/render-profile.json` 与能力接口提供。

## 模块

| 位置 | 功能 |
| --- | --- |
| `contracts/schemas/` | 唯一协议源，包含配置、存档、内容、录制、事件与渲染请求 |
| `packages/protocol/`、`src/chrona/protocol/` | 生成的 TS 导出与 Python 校验适配 |
| `packages/world/` | 确定性 PCG、区域、水域、道路、领域状态、时钟、内容事务及端口 |
| `packages/proxy/`、`src/chrona/authoring/` | 配方编译与检查、代理描述、Agent、tools 和 skills |
| `packages/adapters/` | Rapier、独立 Worker、只读状态副本与世界命令通道 |
| `packages/viewer/`、`apps/web/` | Three.js、地图、LOD、投影、录制、输入、对话与界面 |
| `apps/api/` | Node API、存档、内容注册表、服务转发与依赖组装 |
| `src/chrona/rendering/` | 上下文、提示词、路线分段、重试、媒体与任务管理 |
| `src/chrona/adapters/`、`src/chrona/infrastructure/` | 模型、LoRA、提示增强、配置、日志和资源适配 |
| `harness/authoring/`、`harness/rendering/` | 分开的编写与视频 harness |

世界在独立 Worker 中按固定步推进，绘制不拥有推进权。暂停或零倍速时相机仍可移动；倍速不改变漫游速度。每个世界通过 Web Locks 保留一个写入者，额外标签页通过 BroadcastChannel 查看只读副本。

`loadRange=2` 仍表示中心在内的两层、共 7 个展示区块。物理驻留由实体和可达碰撞环境独立保留，远处物体继续模拟并自然休眠。当前采用保守策略，保留动态实体及休眠岛的物理驻留以维护支撑、接触和唤醒路径；不承诺物理内存随相机范围固定。负载与积压通过运行时指标查询。

## 检查与旧数据

```sh
npm run check
npm run test:browser
uv run --frozen --group dev pytest -q
```

浏览器检查需要已安装的 Chromium，或设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。GPU 环境可运行完整的可选推理测试。`npm run generate:protocol` 更新协议生成物，`npm run check:protocol` 检查是否过期。

旧数据通过 `scripts/import-data.py` 显式选择、校验后导入。默认只显示计划，必须提供 `--apply` 才写入；冲突会保留两端并报错。凭据、Agent 设置和日志不随渲染数据导入。不会自动复制旧 `.data`、重建旧世界或切换旧服务。见 [迁移与兼容](docs/zh-Hans/MIGRATION.md) 和 [使用指南](docs/zh-Hans/USAGE.md)。

`tests/` 不再被忽略，可随源码提交；`.docs/` 保留历史内部记录。正式架构、接口、部署和验证文档位于受版本管理的 `docs/`。`report/` 保留原报告与所引用的精选媒体，作为原项目展示证据。
