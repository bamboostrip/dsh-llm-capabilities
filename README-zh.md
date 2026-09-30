# dsh-llm-capabilities

> **DSH 插件：为 `llm-pi-ai` 自动检测并配置模型能力（思考档位 + 容量）。**
> `dsh-reasoning-efforts` 的后继者 — 一个面板补齐官方 `llm-pi-ai` 对自建网关缺省不可配的字段。

[English](./README.md) | 简体中文

## 为什么需要

官方 `llm-pi-ai` 自建模型的设置页只能改 `contextWindow`，真正决定路由的能力却没开放：

1. **思考档位**（`reasoningEfforts`）：模型接受哪些 `off/minimal/low/medium/high/xhigh/max`，每档在网关上的真实写法（`max: ultra`）。不配，强度滑块就提示“当前模型未提供可选择的思考档位”。

视觉（`input`）曾是第二个缺口，但官方设置现已支持视觉声明 — 所以从 0.2.0 起本插件不再碰 `input`（保存时原样保留，包括官方 UI 写入的值）。

从 `dsh-reasoning-efforts` 来的：老包保留可用，本插件同时服务新旧两个路由（`/model-capabilities/raw-models` + 兼容 `/thinking-levels/raw-models`），新装请用本包。

## 功能

- **一个设置页** `设置 → 模型能力`
- **选中即自动检测**：选定 provider 后服务端拉 `GET {baseURL}/models`（凭证在服务端解析，不泄露），解析：
  - `supported_features: ["reasoning"]` / `supports_reasoning` / `reasoning_effort` … → 思考
  - `context_length` / `max_output_tokens` … → 容量
- **目录互补**：`llm.models()` 的 `pi-ai` 目录知识作为第二来源，端点显式信号优先，目录在端点沉默时补位
- **已配置状态回显**：重新检测不会抹掉已保存的 `reasoningEfforts`——配过的模型无论端点有无信号，都原样回显自己的档位（含自定义网关写法）
- **未配置模型提示**：端点有但你还没配的模型会标 `未配置`，保存即加入设置
- **视觉不动**：`input` 从不写入、从不删除；官方 UI 声明什么就是什么
- **吸底保存栏**：滚动时唯一的“保存更改”始终钉在列表底部，不用拖回顶部；毛玻璃底，内容不会从栏下穿透
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
2. 打开 `设置 → 模型能力`，选中 provider 后自动检测
3. 按模型勾 `提供思考档位` → 选 `off/low/medium/high/xhigh/max`，需要时点铅笔自定义每档网关真实写法
4. **保存更改** → 写入 `llm-pi-ai`（`providers.<route>.models`），强度滑块立刻生效；`input`/视觉保持官方 UI 设置的原样

## 写入的配置长这样

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      baseURL: https://gateway.example/v1
      api: openai-completions
      models:
        - id: gpt-4o
          input: [text, image]           # 视觉 — 官方 UI 写入，本插件保存时原样保留
          reasoningEfforts:              # 思考 — 本插件写入
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
| 视觉 | ❌ | 交由官方 UI；保存时 `input` 原样保留 |
| 服务端路由 | `/thinking-levels/raw-models` | `/model-capabilities/raw-models` + 兼容老路由 |

过渡期可共存，择机迁移即可。

## 许可证

MIT © hank reed (bamboostrip)
