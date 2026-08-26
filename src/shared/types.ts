/**
 * Shared types for the DSH Model Capabilities plugin.
 *
 * Extends the thinking-levels lineage to cover both reasoning and
 * vision (input modalities). Targets the real DSH `llm-pi-ai` settings
 * namespace where each provider route's `models[]` entries accept:
 *  - `reasoningEfforts` map (pi-ai canonical levels)
 *  - `input` array (["text"] | ["text","image"])
 *  - `contextWindow` / `maxTokens`
 *
 * Successor to dsh-reasoning-efforts: keep its reasoning lineage,
 * add first-class vision so a self-hosted gateway model can be marked
 * as image-capable without hand-editing settings.yaml.
 */

// ---------------------------------------------------------------------------
// Raw provider listing
// ---------------------------------------------------------------------------

/** One raw entry as returned by a provider's `GET /models` endpoint. */
export interface ApiModelEntry {
  id: string
  name?: string
  display_name?: string
  // capacity
  context_length?: number
  context_window?: number
  max_output_tokens?: number
  max_tokens?: number
  // reasoning signals (any of these may appear)
  supported_features?: string[]
  supported_parameters?: string[]
  supports_reasoning?: boolean
  supportsReasoning?: boolean
  can_reason?: boolean
  reasoning?: boolean
  supports_reasoning_effort?: boolean
  reasoning_effort?: unknown
  // modality / vision signals (any of these may appear)
  modalities?: string[] | string
  input_modalities?: string[] | string
  inputModalities?: string[] | string
  supported_modalities?: string[]
  vision?: boolean
  supports_vision?: boolean
  supportsVision?: boolean
  supports_image?: boolean
  supportsImage?: boolean
  capability?: string
  capabilities?: string[] | Record<string, unknown>
  [key: string]: unknown
}

/** A provider's `GET /models` reply (OpenAI-compatible list shape). */
export interface ApiModelListResponse {
  data?: ApiModelEntry[]
  object?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/** Canonical pi-ai thinking levels, in escalation order. */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * reasoningEfforts map written into a model entry.
 * key = offered level, value = wire spelling (empty/null only legal for `off`).
 * `false` (not represented here) declares a non-reasoning model.
 */
export type ReasoningEfforts = Partial<Record<ThinkingLevel, string | null>>

// ---------------------------------------------------------------------------
// Vision / input modalities
// ---------------------------------------------------------------------------

/** Input modalities pi-ai currently gates. Extensible: validators accept ["text"] | ["text","image"]. */
export const INPUT_MODALITIES = ['text', 'image'] as const
export type InputModality = (typeof INPUT_MODALITIES)[number]

/**
 * Normalized vision capability for one model.
 *  - ['text','image']  → image-capable, pi-ai will allow `contentHasImage`
 *  - ['text']          → text-only, pi-ai will reject images with UNSUPPORTED_CONTENT
 *  - undefined         → unknown / inherit (catalog or defaultInput)
 */
export type InputCapability = readonly InputModality[] | undefined

// ---------------------------------------------------------------------------
// Settings-facing model shape
// ---------------------------------------------------------------------------

/** The model fields DSH's llm-pi-ai schema accepts (configurable subset). */
export interface ModelConfig {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: ReasoningEfforts | false
  /** pi-ai `input` field; omit to inherit catalog/default. */
  input?: InputModality[]
}

export type ModelInputState = 'inherit' | 'vision' | 'text-only'

/** One provider route from the llm-pi-ai settings section. */
export interface ProviderConfig {
  route: string
  displayName?: string
  apiKeyEnv?: string
  baseURL?: string
  api?: string
  models: ModelConfig[]
}

/** The full resolved `llm-pi-ai` settings section (as read via ctx.settings.get). */
export interface LlmPiAiSettings {
  providers?: Record<string, Omit<ProviderConfig, 'route'>>
}

// ---------------------------------------------------------------------------
// Detection result (unified for both capabilities)
// ---------------------------------------------------------------------------

export interface VisionDetection {
  /** true = vision confirmed, false = explicitly text-only, undefined = unknown */
  vision: boolean | undefined
  visionSource: string | null
  /** Proposed `input` to write, when vision is known. */
  input?: InputModality[]
}

export interface ReasoningDetection {
  reasoning: boolean | undefined
  reasoningSource: string | null
  reasoningEfforts?: ReasoningEfforts
}

/** Per-model unified detection outcome. */
export interface DetectionResult {
  id: string
  found: boolean
  // reasoning
  reasoning: boolean | 'unknown' | 'manual' | 'off'
  reasoningSource?: string
  reasoningEfforts?: ReasoningEfforts
  // vision
  vision: boolean | 'unknown' | 'manual' | 'off'
  visionSource?: string
  input?: InputModality[]
  // capacity
  contextWindow?: number
  maxTokens?: number
  name?: string
  confidence: 'high' | 'medium' | 'low'
  note?: string
}
