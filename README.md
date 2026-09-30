# dsh-llm-capabilities

> **DSH plugin: auto-detect and configure model capabilities (reasoningEfforts + capacities) for `llm-pi-ai`.**
> Successor to `dsh-reasoning-efforts` — one panel patches the fields the official `llm-pi-ai` UI leaves unconfigurable for self-hosted gateways.

English | [简体中文](./README-zh.md)

## Why

The official `llm-pi-ai` settings page for a custom provider only lets you edit `contextWindow`. What actually matters for routing stays hidden:

1. **Thinking levels** (`reasoningEfforts`) — which `off/minimal/low/medium/high/xhigh/max` the model accepts, and the wire spelling (`max: ultra`) each level maps to. Without this the intensity slider says *“this model provides no selectable thinking levels”*.

Vision (`input`) used to be the second gap, but the official UI declares input modalities itself now — so since 0.2.0 this plugin leaves `input` strictly alone (existing values are preserved untouched on every save).

If you came from `dsh-reasoning-efforts`: keep it, it still works. `dsh-llm-capabilities` serves both endpoints (`/model-capabilities/raw-models` and legacy `/thinking-levels/raw-models`) so old clients keep working. New installs should use this package.

## What it does

- **One settings page** `Settings → Model Capabilities`
- **Auto-detect on selection**: picking a provider fetches `GET {baseURL}/models` server-side (credential resolved host-side, no key leak) and parses:
  - `supported_features: ["reasoning"]`, `supported_parameters`, `supports_reasoning`, `reasoning_effort` … → reasoning
  - `context_length`, `max_output_tokens` … → capacities
- **Catalog-aware**: merges `llm.models()` (pi-ai's own knowledge) as a complementary source — the endpoint wins for yes/no, the catalog refines the level set and stands in when the endpoint says nothing.
- **Configured state echoes back**: re-detection never erases saved `reasoningEfforts` — models already configured show their own levels (custom wire spellings included) whether or not the endpoint lists signals.
- **New models**: endpoint lists a model you haven't configured yet → it shows up with a `not configured` badge, saving will add it.
- **Vision preserved**: `input` is never written or removed; whatever the official UI declared stays as-is.
- **Sticky save bar**: a single “Save changes” button pinned to the bottom of the list while you scroll — no scrolling back to the top; frosted-glass surface so list content never bleeds through.
- **Safe writes**: `settings.mutate` with `expectedRevision`, deep-cloned `models` array, no other provider fields are touched.

## Install

```powershell
# published
dsh plugin --profile web add dsh-llm-capabilities

# local dev
dsh plugin --profile web add link:D:\AllCode\dsh\dsh-llm-capabilities
```

Requires `DHS >= 0.1.1-rc.2`, `node >= 22.13`.

## Usage

1. Add your provider in `Settings → Models` as usual (route, baseURL, apiKeyEnv).
2. Open `Settings → Model Capabilities` and pick the provider — detection runs automatically.
3. Toggle `Offer thinking levels` per model: pick `off/low/medium/high/xhigh/max`; customize wire spellings via the pencil icon when needed.
4. **Save changes** → writes to `llm-pi-ai` (`providers.<route>.models`). The intensity slider updates immediately; `input`/vision stays however the official UI set it.

## Go session header (`x-opencode-session`)

OpenCode Go requires third-party agents to send a stable `x-opencode-session`
header for prompt-cache affinity ([docs](https://opencode.ai/docs/go/#where-can-i-use-it)).
The host half wraps `globalThis.fetch` and sets it on requests whose URL contains
`opencode.ai/zen/go` (covers `ocg-c` / `ocg-r` / `ocg-a`). All other requests
pass through untouched.

- **Conversation keying (default):** `ses_` + 32 hex derived from the dsh
  conversation id (`sha256`), so the same chat keeps the same OpenCode session
  across restarts. Title calls use an isolated namespace; compaction rides the
  conversation's namespace because it replays history (reasoning
  `encrypted_content` is bound to the account that issued it).
- **Encrypted-reasoning self-heal:** if the gateway still answers
  `400 … reasoning 'encrypted_content' was not issued to this caller`
  (session→account affinity lost on the gateway side), the wrapper retries
  once with the replayed encrypted reasoning items stripped instead of
  failing the turn. Opt out with `sessionHeaders.encryptedContentRetry: false`.
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

## Configuration shape written

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      baseURL: https://gateway.example/v1
      api: openai-completions
      models:
        - id: gpt-4o
          input: [text, image]          # vision — written by the official UI, preserved by this plugin
          reasoningEfforts:              # thinking — written by this plugin
            off: null
            low: low
            medium: medium
            high: high
        - id: text-only-model
          input: [text]
          reasoningEfforts: false        # explicitly no reasoning
```

## How detection works

`llm.discoverModels` is intentionally narrowed host-side to `id/name/contextWindow/maxTokens`. This plugin adds a host route that returns the **raw** listing:

```
GET /model-capabilities/raw-models?route=<route>
```

It reads `baseURL/apiKeyEnv` from your own `llm-pi-ai` settings, resolves the credential via `ctx.credentials`, fetches `{baseURL}/models`, and returns `{ok, data}` without ever echoing the secret. Only routes you already configured are reachable (browser trust fence: rejects cross-site, checks Origin/Host).

## Development

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm run dev   # watch
```

The web bundle is a `window.__ModuleLoader__.load({id, factory})` closure — not ESM — so keep client imports to platform modules (`react`, `@deepseek-ai/dsh-client-*`) only.

## Relation to dsh-reasoning-efforts

|  | dsh-reasoning-efforts | dsh-llm-capabilities (this) |
|---|---|---|
| reasoning auto-detect | ✅ | ✅ (ported, strict TS) |
| vision | ❌ | handled by the official UI; `input` preserved on save |
| host route | `/thinking-levels/raw-models` | `/model-capabilities/raw-models` + legacy compat |

Migrate when ready — both can coexist during the transition.

## License

MIT © hank reed (bamboostrip)
