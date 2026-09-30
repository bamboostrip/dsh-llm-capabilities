# Changelog

## 0.1.5 — 2026-09-30

- Vision handed back to the official UI: llm-pi-ai now declares `input` modalities itself, so the panel drops the three-state vision editor and saving no longer writes or deletes `input` — existing values (including ones set by the official UI) are preserved untouched. Detection still parses vision signals in the shared lib, but the panel neither surfaces nor stores them.
- Settings page rework:
  - Single, always-reachable save: the toolbar keeps only provider selection + re-detect; one “Save changes” button lives in a sticky frosted-glass bar pinned to the bottom of the list (with the model count), so it follows scrolling and never requires scrolling back to the top. The bar is an opaque field-fill card with backdrop blur, fixing the old sticky footer whose background resolved to transparent inside the settings dialog and let content bleed through. Saving flips the button to “Saved ✓” for a moment.
  - Auto-detect on provider selection, once per route; manual edits survive provider switching. “Detect” becomes “Re-detect” once results exist.
  - Thinking-level editor rebuilt: switch toggle + level pills. A selected level shows only its name plus a pencil icon — the wire-spelling override input stays hidden until the pencil is clicked (default selections stay clean, no dashed-underline clutter), and a per-model “Reset” action restores defaults.
  - Fix the `off` level: checking it now stores `off: null` (its legal wire value); the old editor treated `null` as “remove the level”, so `off` could be unchecked but never re-checked.
  - Re-detect echoes existing configuration: models already saved with `reasoningEfforts` show that exact state (switch on, their own levels and wire spellings) after auto/manual re-detection, even when the endpoint and catalog are silent — previously they flipped to “unknown” and the switch looked off, as if thinking was never configured. Configured levels also win over detection defaults, so custom wire spellings survive re-detection; the endpoint/catalog can still upgrade an explicit `reasoningEfforts: false` to “supported”.
  - Unprovable providers degrade to an echo, not an error: routes with neither a reachable `baseURL` nor a shipped catalog (e.g. gateway routes like `ocg-c`) made `discoverModels` throw a red banner on every page entry once auto-detect landed. Now the saved configuration is echoed and the entry stays quiet; a manual re-detect shows a soft notice explaining there is nothing to probe.
  - Cards, badges and status colors aligned to the DSW alias tokens (soft-tinted pills instead of outlined text); “model not present in the endpoint listing” no longer leaks a hardcoded English string.
- Removed the redundant “Pre-fill from catalog” button — endpoint detection already merges catalog knowledge.

## 0.1.4 — 2026-09-17

- Conversation-scoped `x-opencode-session`: derive a restart-stable id from the dsh conversation (`ses_` + sha256 of session id), via `llm/stream` waterfall + AsyncLocalStorage. Same conversation keeps the same OpenCode session across process restarts (helps `encrypted_content` replay on `ocg-r`). `session-title` uses an isolated namespace; `compaction` deliberately rides the conversation's namespace (it replays history, and reasoning `encrypted_content` is bound to the issuing account). Opt out with `sessionHeaders.keying: process`.
- Encrypted-reasoning self-heal: on `400 … reasoning 'encrypted_content' was not issued to this caller` (gateway lost the session→account binding), retry once with the replayed encrypted reasoning items stripped instead of failing the turn. Covers `fetch(url, init)` and `fetch(Request)` inputs, preserves the abort signal; opt out with `sessionHeaders.encryptedContentRetry: false`.
- UI: sticky bottom “Apply to settings” footer so long model lists no longer require scrolling back to the top to save.

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
