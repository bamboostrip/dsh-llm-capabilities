/**
 * Detection logic for the DSH Model Capabilities plugin.
 *
 * Extends the dsh-reasoning-efforts lineage:
 *  - reasoning detection (supported_features / supports_reasoning etc.)
 *  - vision detection (modalities / supports_vision etc.)
 *
 * Pure, framework-free, strict TS, unit-testable.
 */

import type {
  ApiModelEntry,
  DetectionResult,
  InputModality,
  ReasoningEfforts,
  ThinkingLevel,
  VisionDetection,
  ReasoningDetection,
} from './types.js'
import { THINKING_LEVELS } from './types.js'

// ---------------------------------------------------------------------------
// Reasoning (ported from dsh-reasoning-efforts, strict)
// ---------------------------------------------------------------------------

export const DEFAULT_REASONING_EFFORTS: ReasoningEfforts = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
}

export const FALLBACK_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high']

function pickNumber(entry: ApiModelEntry, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function pickString(entry: ApiModelEntry, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    return out.length > 0 ? out : undefined
  }
  if (typeof value === 'string' && value.length > 0) {
    // comma/space separated string like "text,image"
    const parts = value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return parts.length > 0 ? parts : undefined
  }
  return undefined
}

export function analyzeReasoning(entry: ApiModelEntry): ReasoningDetection {
  const e = entry ?? ({} as ApiModelEntry)
  let reasoning: boolean | undefined
  let source: string | null = null
  let efforts: ReasoningEfforts | undefined

  if (Array.isArray(e.supported_features) && e.supported_features.includes('reasoning')) {
    reasoning = true
    source = 'supported_features'
  } else if (
    Array.isArray(e.supported_parameters) &&
    (e.supported_parameters.includes('reasoning') ||
      e.supported_parameters.includes('include_reasoning'))
  ) {
    reasoning = true
    source = 'supported_parameters'
  } else if (typeof e.supports_reasoning === 'boolean') {
    reasoning = e.supports_reasoning
    source = 'supports_reasoning'
  } else if (typeof e.supportsReasoning === 'boolean') {
    reasoning = e.supportsReasoning
    source = 'supportsReasoning'
  } else if (typeof e.can_reason === 'boolean') {
    reasoning = e.can_reason
    source = 'can_reason'
  } else if (typeof e.reasoning === 'boolean') {
    reasoning = e.reasoning
    source = 'reasoning'
  } else if (e.reasoning_effort !== undefined || e.supports_reasoning_effort === true) {
    reasoning = true
    source = 'reasoning_effort'
  }

  if (reasoning === true) efforts = DEFAULT_REASONING_EFFORTS

  return { reasoning, reasoningSource: source, reasoningEfforts: efforts }
}

// ---------------------------------------------------------------------------
// Vision / input modalities
// ---------------------------------------------------------------------------

/**
 * Normalize a possibly-string-or-array modality field to a lowercase set.
 */
function modalitySet(entry: ApiModelEntry, key: string): Set<string> | undefined {
  const raw = entry[key]
  const arr = asStringArray(raw)
  if (!arr) return undefined
  return new Set(arr.map((s) => s.toLowerCase()))
}

/**
 * Analyze vision capability from one listing entry.
 *
 * Handles:
 *  - modalities: ["text","image"] / "text,image" / { modalities: ["image"] }
 *  - input_modalities / inputModalities / supported_modalities
 *  - vision / supports_vision / supportsVision / supports_image booleans
 *  - capabilities: ["vision"] / { vision: true }
 *  - supported_features containing "vision" / "image" / "multimodal"
 */
export function analyzeVision(entry: ApiModelEntry): VisionDetection {
  const e = entry ?? ({} as ApiModelEntry)

  // 1. Explicit boolean flags (highest signal)
  const boolFlags: Array<[string, unknown]> = [
    ['supports_vision', e.supports_vision],
    ['supportsVision', e.supportsVision],
    ['vision', e.vision],
    ['supports_image', e.supports_image],
    ['supportsImage', e.supportsImage],
  ]
  for (const [key, val] of boolFlags) {
    if (typeof val === 'boolean') {
      return {
        vision: val,
        visionSource: key,
        input: val ? (['text', 'image'] as InputModality[]) : (['text'] as InputModality[]),
      }
    }
  }

  // 2. Array / string modality fields
  const modalityKeys = [
    'modalities',
    'input_modalities',
    'inputModalities',
    'supported_modalities',
    'supportedModalities',
  ] as const

  for (const key of modalityKeys) {
    const set = modalitySet(e, key)
    if (!set) continue
    const hasImage = set.has('image') || set.has('vision') || set.has('multimodal')
    const hasText = set.has('text')
    // If the field mentions image at all, treat as vision
    if (hasImage) {
      return {
        vision: true,
        visionSource: key,
        input: ['text', 'image'] as InputModality[],
      }
    }
    // Explicit text-only declaration (e.g., modalities: ["text"])
    if (hasText && set.size === 1) {
      return {
        vision: false,
        visionSource: key,
        input: ['text'] as InputModality[],
      }
    }
  }

  // 3. supported_features containing vision hints
  if (Array.isArray(e.supported_features)) {
    const feats = e.supported_features.map((s) => String(s).toLowerCase())
    if (feats.includes('vision') || feats.includes('image') || feats.includes('multimodal') || feats.includes('image_input')) {
      return { vision: true, visionSource: 'supported_features', input: ['text', 'image'] as InputModality[] }
    }
  }

  // 4. capabilities field
  const caps = e.capabilities
  if (Array.isArray(caps)) {
    const lower = caps.map((c) => String(c).toLowerCase())
    if (lower.includes('vision') || lower.includes('image') || lower.includes('multimodal')) {
      return { vision: true, visionSource: 'capabilities', input: ['text', 'image'] as InputModality[] }
    }
  } else if (caps !== null && typeof caps === 'object') {
    const rec = caps as Record<string, unknown>
    if (rec.vision === true || rec.supports_vision === true || rec.image === true) {
      return { vision: true, visionSource: 'capabilities', input: ['text', 'image'] as InputModality[] }
    }
    if (rec.vision === false) {
      return { vision: false, visionSource: 'capabilities', input: ['text'] as InputModality[] }
    }
  }

  // 5. No signal
  return { vision: undefined, visionSource: null, input: undefined }
}

export function analyzeEntry(entry: ApiModelEntry): {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning: boolean | undefined
  reasoningSource: string | null
  vision: boolean | undefined
  visionSource: string | null
} {
  const r = analyzeReasoning(entry)
  const v = analyzeVision(entry)
  return {
    id: pickString(entry, 'id') ?? '',
    name: pickString(entry, 'name', 'display_name'),
    contextWindow: pickNumber(entry, 'context_window', 'context_length'),
    maxTokens: pickNumber(entry, 'max_output_tokens', 'max_tokens', 'max_output_length'),
    reasoning: r.reasoning,
    reasoningSource: r.reasoningSource,
    vision: v.vision,
    visionSource: v.visionSource,
  }
}

/** Build a DetectionResult for one configured model id from its listing entry. */
export function detectModel(id: string, entry: ApiModelEntry | undefined): DetectionResult {
  if (!entry) {
    return {
      id,
      found: false,
      reasoning: 'unknown',
      vision: 'unknown',
      confidence: 'low',
      note: 'model not present in the endpoint listing (check the API key, or the provider exposes no usable /models listing)',
    }
  }
  const analyzed = analyzeEntry(entry)
  const r = analyzeReasoning(entry)
  const v = analyzeVision(entry)

  // reasoning branch
  let reasoning: DetectionResult['reasoning']
  let reasoningEfforts: ReasoningEfforts | undefined
  let reasoningSource: string | undefined
  if (r.reasoning === true) {
    reasoning = true
    reasoningEfforts = r.reasoningEfforts
    reasoningSource = r.reasoningSource ?? undefined
  } else if (r.reasoning === false) {
    reasoning = false
    reasoningSource = r.reasoningSource ?? undefined
  } else {
    reasoning = 'unknown'
  }

  // vision branch
  let vision: DetectionResult['vision']
  let input: InputModality[] | undefined
  let visionSource: string | undefined
  if (v.vision === true) {
    vision = true
    input = v.input
    visionSource = v.visionSource ?? undefined
  } else if (v.vision === false) {
    vision = false
    input = v.input
    visionSource = v.visionSource ?? undefined
  } else {
    vision = 'unknown'
  }

  // confidence: high if either signal explicit, low if neither
  const hasSignal = r.reasoning !== undefined || v.vision !== undefined
  const confidence: DetectionResult['confidence'] = hasSignal ? 'high' : 'low'

  return {
    id,
    found: true,
    reasoning,
    reasoningSource,
    reasoningEfforts,
    vision,
    visionSource,
    input,
    contextWindow: analyzed.contextWindow,
    maxTokens: analyzed.maxTokens,
    name: analyzed.name,
    confidence,
  }
}

/** Default level set to offer when the user toggles reasoning manually. */
export function defaultManualEfforts(levels: readonly string[] = FALLBACK_LEVELS): ReasoningEfforts {
  const efforts: ReasoningEfforts = { off: null }
  for (const level of levels) {
    ;(efforts as Record<string, string | null>)[level] = level
  }
  return efforts
}

export { THINKING_LEVELS }
