# dsh-llm-capabilities

> **DSH plugin: auto-detect and configure model capabilities (reasoningEfforts + input modalities) for `llm-pi-ai`.**
> Successor to `dsh-reasoning-efforts` — one panel patches the two fields the official `llm-pi-ai` UI leaves unconfigurable for self-hosted gateways.

English | [简体中文](./README-zh.md)

## Why

The official `llm-pi-ai` settings page for a custom provider only lets you edit `contextWindow`. Two capabilities that actually matter for routing stay hidden:

1. **Thinking levels** (`reasoningEfforts`) — which `off/minimal/low/medium/high/xhigh/max` the model accepts, and the wire spelling (`max: ultra`) each level maps to. Without this the intensity slider says *“this model provides no selectable thinking levels”*.
2. **Vision** (`input: ["text","image"]`) — whether the model accepts images. Without this a gateway model that *does* do vision is still `["text"]` locally, so every image attachment is rejected pre-flight with `UNSUPPORTED_CONTENT` before it ever reaches the endpoint.

Both are per-model fields on `providers.<route>.models[]` that `pi-ai` already understands. This plugin just makes them editable **and auto-detectable**.

If you came from `dsh-reasoning-efforts`: keep it, it still works. `dsh-llm-capabilities` serves both endpoints (`/model-capabilities/raw-models` and legacy `/thinking-levels/raw-models`) so old clients keep working. New installs should use this package.

## What it does

- **One settings page** `Settings → Model Capabilities`
- **Auto-detect from endpoint**: fetches `GET {baseURL}/models` server-side (credential resolved host-side, no key leak), parses:
  - `supported_features: ["reasoning"]`, `supported_parameters`, `supports_reasoning`, `reasoning_effort` … → reasoning
  - `modalities` / `input_modalities` / `supported_modalities` / `supports_vision` / `capabilities: ["vision"]` … → vision
  - `context_length`, `max_output_tokens` … → capacities
- **Catalog-aware**: merges `llm.models()` (pi-ai's own knowledge) as a complementary source — the endpoint wins for yes/no, the catalog refines the level set and stands in when the endpoint says nothing.
- **New models**: endpoint lists a model you haven't configured yet → it shows up with a `not configured` badge, applying will add it.
- **Three-state vision**: `inherit` (omit `input`, use catalog/default) / `image ✓` (`["text","image"]`) / `text-only` (`["text"]`)
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
2. Open `Settings → Model Capabilities`, pick the provider.
3. Click **Detect from endpoint** (or **Pre-fill from catalog** for catalog models).
4. Toggle per model:
   - `Offer thinking levels` → pick `off/low/medium/high/xhigh/max`, edit wire spellings inline
   - `Vision: inherit / image ✓ / text-only`
5. **Apply to settings** → writes to `llm-pi-ai` (`providers.<route>.models`). Intensity slider and image admission update immediately.

## Configuration shape written

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      baseURL: https://gateway.example/v1
      api: openai-completions
      models:
        - id: gpt-4o
          input: [text, image]          # vision
          reasoningEfforts:              # thinking
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
| vision auto-detect | ❌ | ✅ |
| input write | ❌ | ✅ |
| host route | `/thinking-levels/raw-models` | `/model-capabilities/raw-models` + legacy compat |

Migrate when ready — both can coexist during the transition.

## License

MIT © hank reed (bamboostrip)
