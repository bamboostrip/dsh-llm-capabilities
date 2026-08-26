# dsh-llm-capabilities

> **DSH 插件：为 `llm-pi-ai` 自动检测并配置模型能力（思考档位 + 视觉能力）。**
> `dsh-reasoning-efforts` 的后继者 — 一个面板补齐官方 `llm-pi-ai` 对自建网关缺的两个字段。

[English](./README.md) | 简体中文

## 为什么需要

官方 `llm-pi-ai` 自建模型的设置页只能改 `contextWindow`，真正决定路由的两个能力却没开放：

1. **思考档位**（`reasoningEfforts`）：模型接受哪些 `off/minimal/low/medium/high/xhigh/max`，每档在网关上的真实写法（`max: ultra`）。不配，强度滑块就提示“当前模型未提供可选择的思考档位”。
2. **视觉能力**（`input: ["text","image"]`）：模型是否收图。不配，自建网关的视觉模型本地仍是 `["text"]`，发图直接被 `UNSUPPORTED_CONTENT` 拦在本地，根本到不了网关。

这两个都是 `providers.<route>.models[]` 上 `pi-ai` 早就认识的字段，本插件只是让它们可编辑、且可自动检测。

从 `dsh-reasoning-efforts` 来的：老包保留可用，本插件同时服务新旧两个路由（`/model-capabilities/raw-models` + 兼容 `/thinking-levels/raw-models`），新装请用本包。

## 功能

- **一个设置页** `设置 → 模型能力`
- **从端点自动检测**：服务端拉 `GET {baseURL}/models`（凭证在服务端解析，不泄露），解析：
  - `supported_features: ["reasoning"]` / `supports_reasoning` / `reasoning_effort` … → 思考
  - `modalities` / `input_modalities` / `supports_vision` / `capabilities: ["vision"]` … → 视觉
  - `context_length` / `max_output_tokens` … → 容量
- **目录互补**：`llm.models()` 的 `pi-ai` 目录知识作为第二来源，端点显式信号优先，目录在端点沉默时补位
- **未配置模型提示**：端点有但你还没配的模型会标 `未配置`，应用即加入设置
- **视觉三态**：`继承默认`（不写 `input`，走目录/缺省） / `支持图片`（`["text","image"]`） / `仅文本`（`["text"]`）
- **安全写入**：`settings.mutate` 带 `expectedRevision`，深拷贝 `models` 数组，不动同路由其他字段

## 安装

```powershell
# 已发布
dsh plugin --profile web add dsh-llm-capabilities

# 本地开发
dsh plugin --profile web add link:D:\AllCode\dsh\dsh-llm-capabilities
```

要求 `DHS >= 0.1.1-rc.2`，`node >= 22.13`。

## 使用

1. 在 `设置 → 模型` 按以往加好 provider（route、baseURL、apiKeyEnv）
2. 打开 `设置 → 模型能力`，选 provider
3. 点 **从端点检测**（目录模型也可点 **从目录预填**）
4. 每行按需：
   - 勾 `提供思考档位` → 选 `off/low/medium/high/xhigh/max`，可改每档网关真实写法
   - `视觉能力：继承默认 / 支持图片 / 仅文本`
5. **应用到设置** → 写入 `llm-pi-ai`（`providers.<route>.models`），强度滑块和发图判断立刻生效

## 写入的配置长这样

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      baseURL: https://gateway.example/v1
      api: openai-completions
      models:
        - id: gpt-4o
          input: [text, image]
          reasoningEfforts:
            off: null
            low: low
            medium: medium
            high: high
```

## 检测原理

`llm.discoverModels` 在服务端被收窄到 `id/name/contextWindow/maxTokens`。本插件加一个同源路由返回原始列表：

```
GET /model-capabilities/raw-models?route=<route>
```

从你自己的 `llm-pi-ai` 设置里读 `baseURL/apiKeyEnv`，经 `ctx.credentials` 解析后去 `GET {baseURL}/models`，返回 `{ok, data}` 且永不回显密钥。仅能访问你已配置的路由，带浏览器信任围栏（拒 `cross-site`，校验 `Origin/Host`）。

## 开发

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm run dev   # watch
```

Web 包是 `window.__ModuleLoader__.load({id,factory})` 闭包而非 ESM，client 侧请只依赖平台模块（`react`、`@deepseek-ai/dsh-client-*`）。

## 与 dsh-reasoning-efforts 的关系

|  | dsh-reasoning-efforts | dsh-llm-capabilities（本包） |
|---|---|---|
| 思考自动检测 | ✅ | ✅（移植并加严 TS） |
| 视觉自动检测 | ❌ | ✅ |
| `input` 写入 | ❌ | ✅ |
| 服务端路由 | `/thinking-levels/raw-models` | `/model-capabilities/raw-models` + 兼容老路由 |

过渡期可共存，择机迁移即可。

## 许可证

MIT © hank reed (bamboostrip)
