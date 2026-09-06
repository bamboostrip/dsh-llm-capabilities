# OpenCode Go `x-opencode-session` 适配：目标背景

> 给接手开发的人看的。实现计划见同目录 `go-session-header-plan.md`。
> 日期：2026-09-07；插件：`dsh-llm-capabilities`（本仓库）。

## 1. 官方要求（真实，非传言）

OpenCode Go 文档 `https://opencode.ai/docs/go/#where-can-i-use-it` 原文：

> OpenCode Go is designed to be used with OpenCode and other popular coding agents
> that produce a similar types of requests. Traffic is monitored for abusive traffic
> that degrades the experience for other users. To ensure your account does not get
> flagged, make sure the tool you're using:
> 1. does not generate abusive traffic
> 2. properly identifies itself (no broad user agents)
> 3. includes the `x-opencode-session` header so we can optimize prompt caching

三条都要满足。当前 dsh 满足第 1、2 条，缺第 3 条——这就是本需求的全部内容：**给发往 Go 的请求加上稳定、可复用的 `x-opencode-session` 请求头**。

## 2. 关键区分：Go ≠ Zen `-free`（别用错方案）

| | Zen `-free` 模型 | Go 订阅模型（本次目标） |
|---|---|---|
| 网关行为 | 按 `User-Agent: opencode/...` 分配免费池，第三方 UA 直接 `429 FreeUsageLimitError` | 订阅制，不卡 UA；反而要求诚实标识（规则第 2 条） |
| 已有解法 | `dsh-zen-proxy`（伪造官方 UA 的本地代理）、`dsh-plugin-zen-useragent` | 无，缺 `x-opencode-session` |
| 本需求能否伪造 UA | — | **禁止**。`broad user agent` 正是官方点名要避免的，用 `opencode/...` 冒充反而增加被标记风险 |

结论：**`User-Agent` 保持 dsh 原样**（`deepseek-harness/x.y.z (+url)`，见 `@deepseek-ai/dsh-llm` 的 `attributionHeaders()`），**只加 `x-opencode-session`**。

## 3. 现状

- 用户配置（`$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers`）：
  - `ocg-r`：`api: openai-responses`，`baseURL: https://opencode.ai/zen/go/v1`
  - `ocg-c`：`api: openai-completions`，`baseURL: https://opencode.ai/zen/go/v1`
  - 两者同 host、不同路径（`/responses` vs `/chat/completions`），所以拦截规则按 **host 子串** `opencode.ai/zen/go` 匹配即可一次覆盖；将来若加 `/messages` 路由也自动生效。
- `llm-pi-ai` 的 header 规则（见其 README）：只有 `user-agent` 会被 attribution 机制强制覆盖（`Harness app attribution wins a conflicting configured header name`），`x-opencode-session` 是非冲突头，可以直通——但 `settings.yaml` 里只能写**静态值**，做不到“每会话固定、跨会话隔离”，所以需要插件在请求层动态注入。
- 本插件现状：host 半（`src/index.ts`）只注册了一个同源探针路由（`GET /model-capabilities/raw-models`），不碰出站请求；LLM 出站请求由 host 进程经 `globalThis.fetch` 发出——这正是下钩子的位置。

## 4. 决策（已和 owner 对齐）

1. **不新建插件，直接扩展本插件**：同一 `apply(ctx)` 里加第二个 `ctx.effect`，共用安装/升级/生命周期；新逻辑隔离在独立模块 `src/session-headers.ts`，不碰现有检测代码。
2. **方案 = 轻量 fetch 包装**（对标 `QiE2035/dsh-llm-headers` 的做法）：只对命中 `opencode.ai/zen/go` 的请求 `set("x-opencode-session", ...)`，其余原样透传；绝不碰 `user-agent` / `authorization`。
3. **值策略 = 每会话固定**：同 dsh 会话内所有请求复用同一个 `ses_<32位hex>`（官方 CLI 形状），换会话换值。v1 用插件生命周期内稳定的单值 + 按 key 的 `Map` 存储（详见计划）；刻意**不**每次请求随机（随机 = 缓存吃不到，白加）。
4. **非目标**：不改 UA、不做代理、不加设置页 UI（entry `config` 开关即可）、不动付费/免费配额逻辑。

## 5. 验收标准

- [ ] 发往 `https://opencode.ai/zen/go/v1/*` 的请求（`ocg-c` 和 `ocg-r`）都带 `x-opencode-session: ses_<32 hex>`，同会话内值不变。
- [ ] `user-agent` 仍是 `deepseek-harness/...`，`authorization` 原样。
- [ ] 非 Go 请求（其他 provider、探针路由、`/models` 发现等）header 零变化。
- [ ] 插件禁用/卸载后 `fetch` 恢复原状，不影响其他插件的包装链。
- [ ] `pnpm run typecheck`、`pnpm test` 全绿；README 有新小节说明开关。

## 6. 参考

- Go 文档：`https://opencode.ai/docs/go/`（Where can I use it / Endpoints / Usage limits）
- Zen 文档（仅作对比）：`https://opencode.ai/docs/zen/`
- 背景 issue：`anomalyco/opencode#42029`、`#42074`（Zen 免费池 UA 门控）；`NousResearch/hermes-agent#81584`（缺 `x-opencode-session` 导致 `400 Model is unavailable`）
- 对标插件：`Yee-h/dsh-zen-proxy`（代理做法，本需求**不**采用）、`QiE2035/dsh-llm-headers`（fetch 包装做法，本需求采用同构思路）

## 附：会话 seam 候选（Task 1 结论，2026-09-07）

**cordis `apply` 签名（`node_modules/@deepseek-ai/cordis/lib/types/registry.d.ts:70-80`）：**

```ts
/** Function plugin called with `(ctx, config)`. */
interface Function<T = any> extends Base<T> {
  (ctx: Context, config: T): any;
}
/** Object plugin with an `apply(ctx, config)` method. */
interface Object<T = any> extends Base<T> {
  apply(ctx: Context, config: T): any;
}
```

无 `Config` schema 时 `resolveConfig` 原样返回 raw config（`fiber.d.ts:27-30`），
所以 `apply(ctx, config?)` 的第二个参数即 entry `config:` 块内容，可直接读
`config?.sessionHeaders`。`ctx.effect(execute, label?)` 签名（`fiber.d.ts:157-159`）
与本仓库现有 `ctx.effect(() => ..., '...')` 用法一致。

**会话 seam 候选（仅 1 个，不阻塞 v1）：**

```powershell
Select-String -Path "node_modules/@deepseek-ai/*/lib/types/*.d.ts" -Pattern "interface.*Session|sessionId"
# 唯一命中：
# node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:361:
#     sessionId?: Branded<'SessionId'>;
```

上下文（`types.d.ts:357-361`）：“Session identity stamped by the loop for request
routing. Replay uses it to separate cursors; adapters may map it to model-hidden
transport metadata.” 即 loop 层请求路由标识，host 插件经 cordis 拿不到——
这正是 v1 用 `STABLE_PROCESS_KEY`（插件生命周期内稳定的单值）的原因：
零依赖未公开会话接口，仍满足官方 MUST（header 存在 + 稳定可复用 → 缓存命中）。
v2 若要按 dsh 对话精细 keying，需研究拦截 `llm` 服务调用透传 `sessionId`，
属后续优化，不在本需求范围。
