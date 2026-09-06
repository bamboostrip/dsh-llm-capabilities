# Go `x-opencode-session` Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本插件的 host 半自动给所有发往 OpenCode Go 的请求注入稳定复用的 `x-opencode-session` 请求头，同时保持 `user-agent` 诚实不变。

**Architecture:** 新增纯函数模块 `src/session-headers.ts`（URL 判定 + 会话 ID 生成/存储 + `fetch` 包装，可独立单测），在 `src/index.ts` 的 `apply` 里用第二个 `ctx.effect` 注册/还原包装器；沿用本仓库现有测试风格（`pnpm build` 后用 `node test/*.test.mjs` 测 `dist/` 产物）。

**Tech Stack:** TypeScript strict / ESM / Node ≥22.13 / tsdown / cordis v4 / pnpm 11.22。零新依赖（只用 `node:crypto`）。

**Background:** 先读同目录 `go-session-header-background.md`（官方要求原文、Go≠Zen 的区分、验收标准）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/session-headers.ts` | 新建 | 纯逻辑：`SESSION_HEADER` 常量、默认 URL 模式、`newSessionId`、`shouldInject`、`createSessionIdStore`、`createSessionHeaderFetch`、`isSessionHeaderFetch` |
| `src/index.ts:1-30,161-180` | 修改 | 导入新模块；`apply(ctx, config?)` 接收 entry config；新增 `registerSessionHeaders` 并用 `ctx.effect` 注册 |
| `tsdown.config.ts:33-36` | 修改 | entry 加 `'session-headers': 'src/session-headers.ts'`（照抄 `detection` 条目的模式，供测试从 `dist/` 导入） |
| `package.json:32-39,80-86` | 修改 | `files[]` 加 `dist/session-headers.js` + `.d.ts`；`test` 脚本追加新测试文件 |
| `test/session-headers.test.mjs` | 新建 | 本仓库风格（`node:assert/strict` + 裸 block + `ok()`）的单测，覆盖判定/生成/存储/包装/透传/幂等 |
| `README.md` | 修改 | 新增一节说明开关与行为 |
| `CHANGELOG.md` | 修改 | 顶部加 `Unreleased` 条目 |

---

### Task 1: 确认 cordis 插件配置透传方式

**Files:** 只读：`node_modules/@deepseek-ai/cordis/dist/*.d.ts`（或实际类型路径）

为什么需要这一步：`src/index.ts:161` 现在的 `apply(ctx)` 忽略了第二个参数，而 `cordis.patch.yml` 的 entry 支持 `config:` 块。本任务确认两件事，结论记下来给 Task 6 用。

- [ ] **Step 1: 找到 cordis 的插件 apply 签名**

Run（在仓库根 `D:\AllCode\dsh\dsh-llm-capabilities`，先 `pnpm install`）：

```powershell
Get-ChildItem node_modules/@deepseek-ai/cordis -Recurse -Filter "*.d.ts" | Select-Object FullName
```

Expected: 列出类型文件。然后搜签名：

```powershell
Select-String -Path "node_modules/@deepseek-ai/cordis/dist/*.d.ts" -Pattern "apply.*Context|Plugin.*config|definePlugin" | Select-Object -First 10
```

Expected: 确认插件函数形如 `(ctx: Context, config?: any) => void`（即第二个参数就是 entry `config:` 块的内容）。把确切的签名抄到本任务的结论里。

- [ ] **Step 2: 确认 entry `config:` 会原样传给插件**

依据：对标插件 `QiE2035/dsh-llm-headers` 就是靠 entry `config:` 收 `headers/urlPatterns` 的；且本仓库 `cordis.patch.yml:7-9` 的 `insert: [{id, name}]` 条目天然支持再加 `config:` 字段（dsh profile 机制）。结论：Task 6 里 `apply(ctx, config?)` 直接读 `config?.sessionHeaders`，无需新 settings 命名空间、无需改 `cordis.patch.yml`（用户侧配置时才加 `config:`）。

- [ ] **Step 3: 记录会话 seam 结论（只记录，不实现）**

在已安装的 harness 里搜可用的会话服务名，供将来“按 dsh 对话精细 keying”（v2 优化）使用，不阻塞 v1：

```powershell
Select-String -Path "node_modules/@deepseek-ai/*/dist/*.d.ts" -Pattern "interface.*Session|sessionId" | Select-Object -First 10
```

Expected: 一批候选。把结果原文粘到 `go-session-header-background.md` 末尾的新段 `## 附：会话 seam 候选（Task 1 结论）`。**v1 不依赖它**（见 Task 4 的 `STABLE_PROCESS_KEY` 说明）。

---

### Task 2: 先写失败的单测

**Files:**
- Create: `test/session-headers.test.mjs`

- [ ] **Step 1: 创建测试文件（完整内容，直接落盘）**

```js
/**
 * Session-header tests for dsh-llm-capabilities (Go affinity).
 * Run with `pnpm build && node test/session-headers.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  SESSION_HEADER,
  DEFAULT_URL_PATTERNS,
  newSessionId,
  shouldInject,
  createSessionIdStore,
  createSessionHeaderFetch,
  isSessionHeaderFetch,
} from '../dist/session-headers.js'

function ok(msg) {
  console.log(`✓ ${msg}`)
}

// URL matching
{
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/chat/completions'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/responses'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/models'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/v1/chat/completions'), false)
  assert.equal(shouldInject('https://api.anthropic.com/v1/messages'), false)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/chat/completions', ['']), false)
  ok('shouldInject matches only Go URLs, empty pattern never matches')
}

// Session ID shape + uniqueness
{
  const a = newSessionId()
  const b = newSessionId()
  assert.match(a, /^ses_[0-9a-f]{32}$/)
  assert.notEqual(a, b)
  ok('newSessionId shape + uniqueness')
}

// Store stability
{
  const store = createSessionIdStore()
  assert.equal(store.get('k'), store.get('k'))
  assert.notEqual(store.get('k1'), store.get('k2'))
  assert.equal(store.size, 3)
  store.clear('k1')
  assert.equal(store.size, 2)
  ok('store stable per key, isolated across keys')
}

// Wrapper sets header on match, string URL
{
  let seen
  const fake = async (input, init) => {
    seen = { url: input, headers: new Headers(init?.headers) }
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  assert.equal(isSessionHeaderFetch(patched), true)
  assert.equal(isSessionHeaderFetch(fake), false)
  await patched('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/probe', authorization: 'Bearer secret' },
  })
  assert.match(seen.headers.get(SESSION_HEADER) ?? '', /^ses_fixed$/)
  assert.equal(seen.headers.get('user-agent'), 'deepseek-harness/probe')
  assert.equal(seen.headers.get('authorization'), 'Bearer secret')
  ok('wrapper injects session header, preserves UA + auth')
}

// Wrapper passes through non-matching URLs untouched
{
  let calledInit
  const fake = async (input, init) => {
    calledInit = init
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  await patched('https://api.anthropic.com/v1/messages', { method: 'POST' })
  assert.equal(calledInit?.headers, undefined)
  ok('non-Go passthrough')
}

// Wrapper handles Request input
{
  let seen
  const fake = async (input) => {
    seen = new Headers(input.headers)
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  await patched(
    new Request('https://opencode.ai/zen/go/v1/responses', { headers: { 'user-agent': 'deepseek-harness/probe' } }),
  )
  assert.equal(seen.get(SESSION_HEADER), 'ses_fixed')
  assert.equal(seen.get('user-agent'), 'deepseek-harness/probe')
  ok('Request input cloned with header, UA intact')
}

// No session id -> passthrough
{
  let called = false
  const fake = async () => {
    called = true
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => undefined })
  await patched('https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(called, true)
  ok('undefined session id passes through')
}

console.log('session-headers: all tests passed')
```

- [ ] **Step 2: 运行，确认失败（模块还不存在）**

Run:

```powershell
pnpm build; node test/session-headers.test.mjs
```

Expected: FAIL，`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../dist/session-headers.js'`（构建成功但测试文件解析失败）。这证明测试真实关联了待建模块。

---

### Task 3: 实现 `src/session-headers.ts`

**Files:**
- Create: `src/session-headers.ts`

- [ ] **Step 1: 落盘完整实现（直接可用，无需再改）**

```ts
/**
 * OpenCode Go session-affinity headers (host half).
 *
 * OpenCode Go requires third-party agents to send a stable
 * `x-opencode-session` header so the gateway can optimize prompt caching
 * (see docs/go-session-header-background.md). This module wraps
 * `globalThis.fetch` and injects that header on matching URLs only.
 *
 * Deliberately does NOT touch `user-agent` / `authorization`: Go requires
 * honest client identification, and credentials belong to the llm-pi-ai
 * adapter. Only `x-opencode-session` (a non-conflicting header that the
 * attribution mechanism leaves alone) is set.
 */

import { randomBytes } from 'node:crypto'

/** Header name required by OpenCode Go for prompt-cache affinity. */
export const SESSION_HEADER = 'x-opencode-session'

/** Default URL substring allowlist: OpenCode Go endpoints only. */
export const DEFAULT_URL_PATTERNS: readonly string[] = ['opencode.ai/zen/go']

/**
 * v1 session key. One stable id per plugin lifetime: it satisfies the
 * official MUST (header present + stable, so caching works) with zero
 * dependence on undocumented session seams. Cache entries are still keyed
 * by content server-side, so sharing one id is never a correctness bug —
 * only slightly less precise than per-conversation ids. Per-conversation
 * keying is a follow-up once the session seam is confirmed (Task 1 step 3).
 */
export const STABLE_PROCESS_KEY = 'default'

export type FetchFn = typeof fetch

export interface PatchOptions {
  patterns?: readonly string[]
  headerName?: string
  /** Return undefined to pass the request through untouched. */
  getSessionId: () => string | undefined
}

/** Official CLI shape: `ses_` + 128-bit hex. */
export function newSessionId(): string {
  return `ses_${randomBytes(16).toString('hex')}`
}

/** True when `url` contains any non-empty pattern. Empty patterns never match. */
export function shouldInject(url: string, patterns: readonly string[] = DEFAULT_URL_PATTERNS): boolean {
  return patterns.some((p) => p.length > 0 && url.includes(p))
}

const WRAPPED_MARKER = Symbol.for('dsh-llm-capabilities.session-headers.wrapped')

export function isSessionHeaderFetch(fn: unknown): fn is FetchFn {
  if (typeof fn !== 'function') return false
  return (fn as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] === true
}

export interface SessionIdStore {
  /** Stable id for `key`: generated once (`ses_<32hex>`), then reused. */
  get(key: string): string
  clear(key: string): void
  clearAll(): void
  readonly size: number
}

export function createSessionIdStore(): SessionIdStore {
  const map = new Map<string, string>()
  return {
    get(key: string): string {
      const hit = map.get(key)
      if (hit !== undefined) return hit
      const id = newSessionId()
      map.set(key, id)
      return id
    },
    clear(key: string): void {
      map.delete(key)
    },
    clearAll(): void {
      map.clear()
    },
    get size(): number {
      return map.size
    },
  }
}

/**
 * Wrap `original` so matching requests carry the session header.
 * Handles string | URL | Request inputs; existing headers (including any
 * user-configured value) are overwritten on match because a static config
 * value would defeat per-session stability. Non-matching URLs and
 * undefined session ids pass through to `original` untouched.
 */
export function createSessionHeaderFetch(original: FetchFn, options: PatchOptions): FetchFn {
  const patterns = options.patterns ?? DEFAULT_URL_PATTERNS
  const headerName = options.headerName ?? SESSION_HEADER
  const patched = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ): Promise<Response> => {
    const sessionId = options.getSessionId()
    if (sessionId === undefined) return original(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!shouldInject(url, patterns)) return original(input, init)
    if (input instanceof Request) {
      const headers = new Headers(input.headers)
      headers.set(headerName, sessionId)
      return original(new Request(input, { headers }), init)
    }
    const headers = new Headers(init?.headers)
    headers.set(headerName, sessionId)
    return original(input, { ...init, headers })
  }) as FetchFn
  ;(patched as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] = true
  return patched
}
```

- [ ] **Step 2: 确认文件位置**

Run:

```powershell
Test-Path src/session-headers.ts
```

Expected: `True`.

---

### Task 4: 构建配置 + 脚本（让新模块产出 `dist` 并被测试）

**Files:**
- Modify: `tsdown.config.ts:33-36`
- Modify: `package.json:32-39` (`files`), `package.json:80-86` (`scripts.test`)

- [ ] **Step 1: tsdown 加 entry（照抄 `detection` 模式）**

oldString（`tsdown.config.ts`）：

```ts
    entry: {
      index: 'src/index.ts',
      detection: 'src/shared/detection.ts',
    },
```

newString：

```ts
    entry: {
      index: 'src/index.ts',
      detection: 'src/shared/detection.ts',
      'session-headers': 'src/session-headers.ts',
    },
```

- [ ] **Step 2: `package.json` 加产物声明 + 测试脚本**

`files[]` oldString：

```json
  "files": [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/client.js",
    "dist/detection.js",
    "dist/detection.d.ts",
    "cordis.patch.yml"
  ],
```

newString：

```json
  "files": [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/client.js",
    "dist/detection.js",
    "dist/detection.d.ts",
    "dist/session-headers.js",
    "dist/session-headers.d.ts",
    "cordis.patch.yml"
  ],
```

`scripts.test` oldString：

```json
    "test": "pnpm build && node test/detection.test.mjs",
```

newString：

```json
    "test": "pnpm build && node test/detection.test.mjs && node test/session-headers.test.mjs",
```

- [ ] **Step 3: 构建并跑新测试（此时应通过）**

Run:

```powershell
pnpm build; node test/session-headers.test.mjs
```

Expected: 8 行 `✓ ...` + `session-headers: all tests passed`。

---

### Task 5: 接入 `src/index.ts`（注册/还原包装器）

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 加导入（文件顶部，`node:http` 导入之后）**

oldString（`src/index.ts:26-27`）：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
```

newString：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_URL_PATTERNS,
  SESSION_HEADER,
  STABLE_PROCESS_KEY,
  createSessionHeaderFetch,
  createSessionIdStore,
  isSessionHeaderFetch,
} from './session-headers.js'
```

- [ ] **Step 2: 加配置类型（放在 `CredentialsService` 接口之后，`isRecord` 之前）**

插入以下完整代码：

```ts
export interface SessionHeadersConfig {
  /** Default true. Set false to keep the plugin's capabilities UI while disabling header injection. */
  enabled?: boolean
  /** URL substring allowlist. Default `['opencode.ai/zen/go']` (covers ocg-c + ocg-r). */
  urlPatterns?: string[]
  /** Overriding the header name is not recommended; default is the Go-required name. */
  headerName?: string
}

export interface PluginConfig {
  sessionHeaders?: SessionHeadersConfig
}
```

- [ ] **Step 3: 加注册函数（放在 `makeHandler` 之后，`apply` 之前）**

插入以下完整代码：

```ts
function registerSessionHeaders(ctx: Context, config: PluginConfig | undefined): void {
  if (config?.sessionHeaders?.enabled === false) return
  ctx.effect(() => {
    const store = createSessionIdStore()
    const original = globalThis.fetch
    // Another copy of us (or a previous enable) already wrapped it: do not double-wrap.
    if (isSessionHeaderFetch(original)) return () => {}
    const patterns = config?.sessionHeaders?.urlPatterns ?? DEFAULT_URL_PATTERNS
    const headerName = config?.sessionHeaders?.headerName ?? SESSION_HEADER
    globalThis.fetch = createSessionHeaderFetch(original, {
      patterns,
      headerName,
      getSessionId: () => store.get(STABLE_PROCESS_KEY),
    })
    return () => {
      // Restore only if ours is still the outermost wrapper: never break another plugin's chain.
      if (isSessionHeaderFetch(globalThis.fetch)) {
        globalThis.fetch = original
      }
    }
  }, 'model-capabilities: go session headers')
}
```

- [ ] **Step 4: `apply` 接收 config 并调用（保持 `inject` 不变）**

oldString：

```ts
export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsService | undefined
  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (settings === undefined || webServer === undefined) return
```

newString：

```ts
export function apply(ctx: Context, config?: PluginConfig): void {
  registerSessionHeaders(ctx, config)

  const settings = ctx.get('settings') as SettingsService | undefined
  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (settings === undefined || webServer === undefined) return
```

注意：`registerSessionHeaders` 放在守卫之前——即使 `settings/webServer` 缺失，header 注入仍应工作（它不依赖这两个服务）。

- [ ] **Step 5: 全量验证**

Run:

```powershell
pnpm run typecheck; pnpm test
```

Expected: `typecheck` 无输出（通过）；`test` 先打印 detection 的 `✓` 行，再打印 8 行 session-headers 的 `✓` 行，无断言失败。

---

### Task 6: 文档（README + CHANGELOG）

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README 加一节（放在 `## Usage` 之后、`## Configuration shape written` 之前），完整内容：**

````md
## Go session header (`x-opencode-session`)

OpenCode Go requires third-party agents to send a stable `x-opencode-session`
header for prompt-cache affinity ([docs](https://opencode.ai/docs/go/#where-can-i-use-it)).
The host half wraps `globalThis.fetch` and sets it on requests whose URL contains
`opencode.ai/zen/go` (covers both `ocg-c` and `ocg-r` routes). All other requests
pass through untouched.

- Session value: `ses_` + 32 hex chars, generated once and reused (stable per plugin lifetime).
- Never touched: `user-agent` (stays `deepseek-harness/...` — Go requires honest
  identification) and `authorization`.
- Disable without uninstalling (profile `cordis.patch.yml`):

```yaml
- insert:
    - id: model-capabilities
      name: dsh-llm-capabilities
      config:
        sessionHeaders:
          enabled: false
```
````

- [ ] **Step 2: CHANGELOG 顶部加 `Unreleased` 条目，完整内容：**

```md
## Unreleased

- Go affinity: inject a stable `x-opencode-session` (`ses_<32hex>`) header into requests to `opencode.ai/zen/go` (covers `ocg-c`/`ocg-r`); `user-agent`/`authorization` untouched; opt-out via entry `config.sessionHeaders.enabled: false`.
```

- [ ] **Step 3: 提交文档与实现（实现者在自己的分支上执行）**

```powershell
git add src/session-headers.ts src/index.ts tsdown.config.ts package.json test/session-headers.test.mjs README.md CHANGELOG.md docs/go-session-header-background.md docs/go-session-header-plan.md
git status --short
```

Expected: 恰好这 8 个文件（`dist/` 被忽略，不应出现）。确认后再 `git commit`（message 例：`feat: inject stable x-opencode-session header for OpenCode Go`）。**不要**顺手 bump 版本号（发布走 CI trusted publishing）。

---

### Task 7: 端到端验证（本地 echo，不花配额）

**Files:** 无新增（一次性命令）。

- [ ] **Step 1: 跑本地 echo 验证（在仓库根执行，精确命令逐行复制）**

```powershell
node --input-type=module -e "
import http from 'node:http';
import('./dist/session-headers.js').then(async (m) => {
  const seen = {};
  const srv = http.createServer((req, res) => { seen.session = req.headers['x-opencode-session']; seen.ua = req.headers['user-agent']; res.end('{}'); });
  await new Promise((r) => srv.listen(8734, '127.0.0.1', r));
  const store = m.createSessionIdStore();
  const patched = m.createSessionHeaderFetch(fetch, { patterns: ['127.0.0.1:8734'], getSessionId: () => store.get('default') });
  await patched('http://127.0.0.1:8734/v1/chat/completions', { method: 'POST', headers: { 'user-agent': 'deepseek-harness/probe' } });
  await patched('http://127.0.0.1:8734/v1/chat/completions', { method: 'POST', headers: { 'user-agent': 'deepseek-harness/probe' } });
  console.log('session:', seen.session, '| ua:', seen.ua);
  console.log('stable:', seen.session === store.get('default') ? 'YES' : 'NO');
  srv.close();
});"
```

Expected 输出形如：`session: ses_9f2c…（32位hex） | ua: deepseek-harness/probe`，第二行 `stable: YES`。含义：两次请求同值（稳定复用）、UA 原样（诚实标识）。

- [ ] **Step 2: 真实 profile 联调（手动，5 分钟）**

1. `dsh plugin --profile web add link:D:\AllCode\dsh\dsh-llm-capabilities`（若已安装则跳过，确认版本包含本改动）。
2. `ocg-c`/`ocg-r` 任选一个 Go 模型发一句话，确认正常返回、无新增报错。
3. 可选：在 `cordis.patch.yml` 给本插件加 `config: {sessionHeaders: {enabled: false}}` 重启，确认行为回到从前（回归对照），再改回启用。

---

## Self-Review（写完计划后的自查，已执行）

1. **Spec coverage**：背景文档 5 条验收标准逐条有任务——稳定头+双路由覆盖（Task 3/5/7）、UA/auth 不动（Task 2 断言 + Task 7 echo）、非 Go 透传（Task 2 断言）、卸载还原（Task 5 restore + `enabled:false` 开关）、typecheck/test 全绿 + README（Task 5/6）。✓
2. **Placeholder scan**：全文无 TBD/TODO/“自行处理”；唯一开放点是 Task 1 的 cordis 签名确认——已给精确命令与预期输出，且 Task 5 代码只依赖“第二个参数即 entry config”这一条（有对标插件佐证），若签名不符 Task 1 会暴露，Task 6 不执行。✓
3. **Type consistency**：`FetchFn`/`PatchOptions`/`SessionIdStore`/`SessionHeadersConfig`/`PluginConfig` 在 Task 3 定义、Task 5/测试原样引用；`STABLE_PROCESS_KEY` 拼写三处一致；测试导入路径 `../dist/session-headers.js` 与 Task 4 的 tsdown entry 名一致。✓
4. **Scope**：单文件新模块 + 4 处小改 + 文档，无 settings UI、无代理、无版本号改动；`cordis.patch.yml` 无需改（同 id）。✓
