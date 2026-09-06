# Changelog

## 0.1.3 — 2026-09-06

- Go affinity: inject a stable `x-opencode-session` (`ses_<32hex>`) header into requests to `opencode.ai/zen/go` (covers `ocg-c`/`ocg-r`); `user-agent`/`authorization` untouched; opt-out via entry `config.sessionHeaders.enabled: false`.

## 0.1.2 — 2026-09-04

- Compat with dsh `0.1.2-rc.1` breaking change: `@deepseek-ai/dsh-client-runtime` removed, `connection.api` gone (new handle only has `isLoopback/generation/state/rpc/reconnect/registerGenerationSource/start`). Fixes `Settings wire unavailable`.
- Add `createApiClient(remote)` adapter in the client half: `ApiClient` surface and panel code unchanged, new `{ok, value/error}` remotes wrapped to the old `{result: ...}` envelope.
  - `settings.describe({})` → `remote.settings.describe()`
  - `settings.mutate({ns, ops, rev})` → `remote.settings.mutate(ns, ops, rev)`
  - `llm.discoverModels({settingsNs, ...})` → `remote.llm.discoverModels(settingsNs, {...})` (array → `{models}` normalized)
  - `llm.models({})` → `remote.session.modelCatalog()`
- Client `inject`: `['connection', 'slots', 'locale']` → `['slots', 'locale', 'remote', 'remote.llm', 'remote.session', 'remote.settings']`; drop deleted `@deepseek-ai/dsh-client-runtime` from `dsh.client.inject`.

## 0.1.0 — 2026-08-26

- Initial release, successor to `dsh-reasoning-efforts`.
- One settings page `Model Capabilities` that patches both:
  - `reasoningEfforts` (thinking levels, strict TS port from `dsh-reasoning-efforts`)
  - `input` (`["text"]` vs `["text","image"]`, auto-detected)
- Host route `GET /model-capabilities/raw-models` (legacy `/thinking-levels/raw-models` compat) with credential-resolved fetch and browser trust fence.
- Vision detection covers `modalities` / `input_modalities` / `supports_vision` / `capabilities` / `supported_features` signals.
- Three-state vision UI: inherit / image ✓ / text-only, plus catalog-aware reasoning + vision merge.
