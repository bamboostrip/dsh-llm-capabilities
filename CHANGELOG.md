# Changelog

## 0.1.0 — 2026-08-26

- Initial release, successor to `dsh-reasoning-efforts`.
- One settings page `Model Capabilities` that patches both:
  - `reasoningEfforts` (thinking levels, strict TS port from `dsh-reasoning-efforts`)
  - `input` (`["text"]` vs `["text","image"]`, auto-detected)
- Host route `GET /model-capabilities/raw-models` (legacy `/thinking-levels/raw-models` compat) with credential-resolved fetch and browser trust fence.
- Vision detection covers `modalities` / `input_modalities` / `supports_vision` / `capabilities` / `supported_features` signals.
- Three-state vision UI: inherit / image ✓ / text-only, plus catalog-aware reasoning + vision merge.
