/**
 * Client half of the DSH Model Capabilities plugin.
 *
 * Successor to dsh-reasoning-efforts. Registers one additive
 * `settings.section` page ("Model Capabilities") that patches the fields
 * the official llm-pi-ai UI leaves unconfigurable for self-hosted gateways:
 *   1. thinking levels (reasoningEfforts)
 *   2. context / output capacities
 *
 * Vision (`input`) is intentionally NOT touched since 0.2.0: the official
 * llm-pi-ai UI declares input modalities itself now, so this panel neither
 * shows nor writes `input` — existing values are preserved untouched.
 *
 * Strict TS, no `any`. All wire types are locally declared.
 */

import * as React from 'react'
import type {
  ApiModelEntry,
  DetectionResult,
  ReasoningEfforts,
} from './shared/types.js'
import {
  DEFAULT_REASONING_EFFORTS,
  THINKING_LEVELS,
  defaultManualEfforts,
  detectModel,
} from './shared/detection.js'

// ---------------------------------------------------------------------------
// RPC envelope
// ---------------------------------------------------------------------------

type RpcError = { code: string; message: string; details?: unknown }
type RpcResponse<T> = { result: { ok: true; value: T } | { ok: false; error: RpcError } }

interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

interface CatalogReasoning {
  efforts: Array<{ id: string; name: string }>
  defaultEffort?: string
}

interface SettingsNamespaceView {
  ns: string
  value: unknown
  user?: unknown
  revision: number
}

interface CatalogModelEntry {
  id: string
  reasoning?: CatalogReasoning
}

interface CatalogValue {
  groups: Array<{ id: string; models: Array<CatalogModelEntry> }>
  failures: Array<{ id: string; message: string }>
}

interface ApiClient {
  settings: {
    describe(req: Record<string, never>): Promise<RpcResponse<{ writable: boolean; namespaces: SettingsNamespaceView[] }>>
    mutate(req: {
      ns: string
      ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>
      expectedRevision?: number
    }): Promise<RpcResponse<SettingsNamespaceView>>
  }
  llm: {
    discoverModels(req: {
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    }): Promise<RpcResponse<{ models: DiscoveredModel[] }>>
    models(req: Record<string, never>): Promise<RpcResponse<CatalogValue>>
  }
}

// ---------------------------------------------------------------------------
// New-wire remote faces (dsh >= 0.1.2-rc.1, @deepseek-ai/dsh-api-remotes).
// The old `connection.api` envelope `{ result: { ok, value/error } }` is gone;
// remotes return `{ ok, value/error }` directly with positional args.
// This adapter keeps the panel's `ApiClient` + `unwrap` untouched.
// ---------------------------------------------------------------------------

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

interface ClientRemote {
  settings: {
    describe(): Promise<RemoteResult<{ writable: boolean; namespaces: SettingsNamespaceView[] }>>
    mutate(
      ns: string,
      ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>,
      expectedRevision?: number,
    ): Promise<RemoteResult<SettingsNamespaceView>>
  }
  llm: {
    discoverModels(
      settingsNs: string,
      request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
    ): Promise<RemoteResult<DiscoveredModel[] | { models: DiscoveredModel[] }>>
  }
  session: {
    modelCatalog(): Promise<RemoteResult<CatalogValue>>
  }
}

function wrapOk<T>(value: T): RpcResponse<T> {
  return { result: { ok: true, value } }
}

function wrapErr<T>(error: RpcError): RpcResponse<T> {
  return { result: { ok: false, error } }
}

function createApiClient(remote: ClientRemote): ApiClient {
  return {
    settings: {
      describe: async () => {
        const res = await remote.settings.describe()
        return res.ok ? wrapOk(res.value) : wrapErr(res.error)
      },
      mutate: async (req) => {
        const res = await remote.settings.mutate(req.ns, req.ops, req.expectedRevision)
        return res.ok ? wrapOk(res.value) : wrapErr(res.error)
      },
    },
    llm: {
      discoverModels: async (req) => {
        const { settingsNs, ...rest } = req
        const res = await remote.llm.discoverModels(settingsNs, rest)
        if (!res.ok) return wrapErr(res.error)
        const value = Array.isArray(res.value) ? { models: res.value } : res.value
        return wrapOk(value)
      },
      models: async () => {
        const res = await remote.session.modelCatalog()
        return res.ok ? wrapOk(res.value) : wrapErr(res.error)
      },
    },
  }
}

type Translator = (key: string) => string

interface LocaleService {
  register(ns: string, dictionaries: Record<string, Record<string, string>>): unknown
  bind(ns: string): Translator
}

interface ClientContext {
  get(name: 'remote'): ClientRemote | undefined
  get(name: 'remote.llm'): ClientRemote['llm'] | undefined
  get(name: 'remote.session'): ClientRemote['session'] | undefined
  get(name: 'remote.settings'): ClientRemote['settings'] | undefined
  get(name: 'locale'): LocaleService | undefined
  get(name: 'slots'):
    | {
        inject(key: string, cb: () => unknown): () => void
        register(
          def: {
            name: string
            id: string
            order?: number
            label?: string | (() => string)
            inject?: () => Record<string, unknown>
          },
          render: (props: Record<string, unknown>) => React.ReactElement,
        ): () => void
      }
    | undefined
  effect(setup: () => () => void, label?: string): () => void
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const NS = 'llm-pi-ai'
const LOCALE_NS = 'model-capabilities'

const zh: Record<string, string> = {
  nav: '模型能力',
  title: '模型能力',
  intro:
    '补齐自建服务商在 llm-pi-ai 里不可配的字段：思考档位（reasoningEfforts）与上下文/输出容量。选中服务商后自动从端点检测，并结合模型目录判断各模型是否支持思考；调整后点“保存更改”写入 providers.<route>.models。视觉能力（input）已由官方模型设置管理，此处不再修改。',
  detect: '检测能力',
  redetect: '重新检测',
  apply: '保存更改',
  working: '处理中…',
  modelCount: '{n} 个模型',
  saved: '已保存到 llm-pi-ai 设置（providers.{route}.models）。',
  savedDone: '已保存 ✓',
  noProviders: '在 llm-pi-ai 设置中未找到自定义服务商。',
  wireUnavailable: '设置通道不可用。',
  // reasoning
  offerLevels: '提供思考档位',
  resetLevels: '重置默认',
  levelsHint: '点击选择要提供的档位；点铅笔图标可自定义发往 API 的档位名。',
  editLevel: '自定义档位名',
  badgeReasoning: '思考 ✓',
  badgeOff: '无思考',
  badgeUnknown: '未知',
  badgeNotConfigured: '未配置',
  // caps
  capCtx: '上下文 {n}K',
  capOut: '输出 {n}K',
  noteMissing: '模型未出现在端点列表中（请检查 API key，或该服务商不提供可用的 /models 列表）',
  noteNew: '端点已提供该模型但尚未配置；保存后会将其加入设置',
  srcEndpoint: '端点',
  srcCatalog: '目录',
  rawFallbackNote: '原始 /models 读取失败（{detail}），已回退官方发现通道（仅容量，不含推理信号）',
  detectUnavailable: '该服务商没有可用模型目录，也没有可访问的 baseURL（{detail}）。已回显当前已保存的配置，可直接手动编辑。',
  errNotLoaded: 'llm-pi-ai 设置尚未加载',
  errNoCatalog: '模型目录没有该服务商的思考档位信息，请手动设置。',
  errNothingToApply: '没有可保存的修改：请先检测，或在模型上开启思考档位。',
}

const en: Record<string, string> = {
  nav: 'Model Capabilities',
  title: 'Model Capabilities',
  intro:
    'Patch the fields the official llm-pi-ai UI leaves unconfigurable for self-hosted gateways: thinking levels (reasoningEfforts) and context/output capacities. Detecting runs automatically per provider (endpoint + model catalog); edit, then hit "Save changes" to write providers.<route>.models. Vision (input) is managed by the official model settings and is left untouched here.',
  detect: 'Detect',
  redetect: 'Re-detect',
  apply: 'Save changes',
  working: 'Working…',
  modelCount: '{n} models',
  saved: 'Saved to llm-pi-ai settings (providers.{route}.models).',
  savedDone: 'Saved ✓',
  noProviders: 'No providers found in llm-pi-ai settings.',
  wireUnavailable: 'Settings wire unavailable.',
  offerLevels: 'Offer thinking levels',
  resetLevels: 'Reset',
  levelsHint: 'Click to offer a level; the pencil icon customizes the wire spelling.',
  editLevel: 'Edit wire spelling',
  badgeReasoning: 'reasoning ✓',
  badgeOff: 'no reasoning',
  badgeUnknown: 'unknown',
  badgeNotConfigured: 'not configured',
  capCtx: 'ctx {n}K',
  capOut: 'out {n}K',
  noteMissing:
    'model not present in the endpoint listing (check the API key, or the provider exposes no usable /models listing)',
  noteNew: 'advertised by the endpoint but not configured yet; saving will add it',
  srcEndpoint: 'endpoint',
  srcCatalog: 'catalog',
  rawFallbackNote:
    'raw /models read failed ({detail}); fell back to the official discovery channel (capacities only, no reasoning signals)',
  detectUnavailable:
    'No model catalog for this provider and no reachable baseURL ({detail}). Showing the saved configuration; edit levels by hand.',
  errNotLoaded: 'llm-pi-ai settings not loaded yet',
  errNoCatalog: 'The model catalog reports no reasoning knowledge for this provider; set levels manually.',
  errNothingToApply: 'Nothing to save: run detection first, or enable thinking levels on a model.',
}

const fallbackT: Translator = (key) => en[key] ?? key

function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProviderView {
  route: string
  displayName: string
  baseURL?: string
  apiKeyEnv?: string
  api?: string
  raw: Record<string, unknown>
  models: Array<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return (value as unknown[]).map((v) => cloneJson(v)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = cloneJson((value as Record<string, unknown>)[key])
  }
  return out as T
}

function unwrap<T>(response: RpcResponse<T>): T {
  if (!response || !response.result) throw new Error('empty RPC response')
  if (response.result.ok !== true) throw new Error(response.result.error?.message ?? 'RPC failed')
  return response.result.value
}

function providersOf(view: SettingsNamespaceView): ProviderView[] {
  const section = isRecord(view.user) ? view.user : isRecord(view.value) ? view.value : {}
  const providers = isRecord(section.providers) ? section.providers : {}
  const out: ProviderView[] = []
  for (const route of Object.keys(providers)) {
    const profile = providers[route]
    if (!isRecord(profile)) continue
    out.push({
      route,
      displayName:
        typeof profile.displayName === 'string' && profile.displayName.length > 0 ? profile.displayName : route,
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
      api: typeof profile.api === 'string' ? profile.api : undefined,
      raw: profile,
      models: Array.isArray(profile.models)
        ? profile.models.filter((m) => isRecord(m) && typeof (m as { id?: unknown }).id === 'string')
        : [],
    })
  }
  return out
}

type KnownReasoning = Map<string, Map<string, { levels: string[]; defaultEffort?: string }>>

function knownReasoningOf(catalog: CatalogValue): KnownReasoning {
  const known: KnownReasoning = new Map()
  for (const group of catalog.groups ?? []) {
    const byId = new Map<string, { levels: string[]; defaultEffort?: string }>()
    for (const entry of group.models ?? []) {
      if (!entry?.reasoning) continue
      const levels = (entry.reasoning.efforts ?? [])
        .map((e) => e?.id)
        .filter((id): id is string => typeof id === 'string' && (THINKING_LEVELS as readonly string[]).includes(id))
      if (levels.length === 0) continue
      byId.set(entry.id, { levels, defaultEffort: entry.reasoning.defaultEffort })
    }
    if (byId.size > 0) known.set(group.id, byId)
  }
  return known
}

const RAW_MODELS_PATH = '/model-capabilities/raw-models'
const LEGACY_RAW_MODELS_PATH = '/thinking-levels/raw-models'

interface RawModelsReply {
  ok: boolean
  error?: string
  url?: string
  data?: ApiModelEntry[]
}

async function fetchRawModels(route: string): Promise<{ data?: ApiModelEntry[]; error?: string }> {
  const tryFetch = async (path: string): Promise<{ data?: ApiModelEntry[]; error?: string } | null> => {
    try {
      const response = await fetch(`${path}?route=${encodeURIComponent(route)}`)
      const body = (await response.json()) as RawModelsReply
      if (body && body.ok && Array.isArray(body.data)) return { data: body.data }
      // if 404 on new path, let caller try legacy; otherwise surface error
      if (response.status === 404 && path === RAW_MODELS_PATH) return null
      return { error: body?.error ?? `HTTP ${response.status}` }
    } catch (e) {
      if (path === RAW_MODELS_PATH) return null
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  const first = await tryFetch(RAW_MODELS_PATH)
  if (first && first.data) return first
  if (first && first.error && first.error !== null) {
    // try legacy before giving up
    const second = await tryFetch(LEGACY_RAW_MODELS_PATH)
    if (second && second.data) return second
    return first
  }
  // first was null (404) → try legacy
  const second = await tryFetch(LEGACY_RAW_MODELS_PATH)
  if (second) return second
  return { error: 'raw models endpoint not reachable' }
}

function mergeCatalogInto(
  det: DetectionResult,
  info: { levels: string[]; defaultEffort?: string } | undefined,
): DetectionResult {
  if (det.reasoning === true) {
    return {
      ...det,
      reasoningSource: 'endpoint',
      reasoningEfforts: info ? defaultManualEfforts(info.levels) : det.reasoningEfforts ?? DEFAULT_REASONING_EFFORTS,
    }
  }
  if (det.reasoning === 'unknown' && info) {
    return {
      ...det,
      reasoning: true,
      reasoningSource: 'llm catalog',
      reasoningEfforts: defaultManualEfforts(info.levels),
      confidence: 'medium',
    }
  }
  return det
}

/**
 * Echo the already-saved configuration back into a detection result.
 *
 * The saved `reasoningEfforts` are the baseline: detection fills gaps, it
 * never erases them (otherwise a re-detect on a silent endpoint/catalog made
 * configured models look like thinking was off). Custom wire spellings thus
 * survive re-detection. The one upgrade detection may still apply: an
 * explicit `reasoningEfforts: false` becomes "supported" when the
 * endpoint/catalog affirmatively says the model reasons.
 */
function withConfiguredBaseline(
  det: DetectionResult,
  configured: Record<string, unknown> | undefined,
): DetectionResult {
  if (!configured) return det
  const cfg = configured.reasoningEfforts
  if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
    return {
      ...det,
      reasoning: 'manual',
      reasoningSource: undefined,
      reasoningEfforts: cloneJson(cfg) as ReasoningEfforts,
    }
  }
  if (cfg === false) {
    if (det.reasoning === true) return det
    return { ...det, reasoning: 'off', reasoningEfforts: undefined }
  }
  return det
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
.mc-root{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.mc-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.mc-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.mc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-select{height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-field-fill);color:var(--dsw-alias-label-primary);font:inherit;padding:0 10px;min-width:180px;max-width:320px}
.mc-count{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mc-spacer{flex:1}
.mc-btn{height:32px;border:none;border-radius:16px;padding:0 14px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mc-btn:hover:not(:disabled){opacity:.88}
.mc-btn:disabled{opacity:.5;cursor:default}
.mc-btn.ghost{background:var(--dsw-alias-button-secondary-fill);color:var(--dsw-alias-label-primary)}
.mc-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.mc-note{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.mc-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin:0}
.mc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.mc-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.mc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-id{font-size:14px;font-weight:600;line-height:22px}
.mc-name{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.mc-head-badges{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mc-badge{font-size:11px;line-height:16px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.mc-badge.yes{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.mc-badge.new{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-label) 10%,transparent)}
.mc-src{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mc-cap{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mc-divider{height:1px;background:var(--dsw-alias-border-l2)}
.mc-footer{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;margin-top:2px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-field-fill) 86%,transparent);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.mc-switch-row{display:flex;align-items:center;gap:10px}
.mc-switch-label{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;user-select:none}
.mc-switch{position:relative;display:inline-block;width:34px;height:20px;flex:none}
.mc-switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;margin:0;cursor:pointer}
.mc-track{position:absolute;inset:0;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-secondary-fill);transition:background .15s ease,border-color .15s ease;pointer-events:none}
.mc-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s ease,background .15s ease}
.mc-switch input:checked+.mc-track{background:var(--dsw-alias-button-primary-fill);border-color:transparent}
.mc-switch input:checked+.mc-track .mc-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}
.mc-switch input:disabled~.mc-track{opacity:.5}
.mc-switch:has(input:focus-visible) .mc-track{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:1px}
.mc-link{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline dotted}
.mc-link:hover:not(:disabled){color:var(--dsw-alias-label-secondary)}
.mc-link:disabled{cursor:default;opacity:.5}
.mc-efforts{display:flex;flex-direction:column;gap:6px}
.mc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mc-pills{display:flex;flex-wrap:wrap;gap:6px}
.mc-pill{position:relative;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;padding:2px 6px 2px 10px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;transition:border-color .15s ease,color .15s ease,background .15s ease}
.mc-pill:hover{border-color:var(--dsw-alias-label-tertiary)}
.mc-pill.active{border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-fill);background:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 10%,transparent)}
.mc-pill input[type=checkbox]{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.mc-pill:has(input:focus-visible){outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:1px}
.mc-pill-edit{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:50%;background:none;padding:0;color:inherit;opacity:.55;cursor:pointer}
.mc-pill-edit:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.mc-pill-edit.on{opacity:1}
.mc-pill-edit:disabled{cursor:default}
.mc-pill-edit svg{display:block}
.mc-pill input[type=text]{width:64px;border:none;border-bottom:1px solid color-mix(in srgb,currentColor 45%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:0 2px;outline:none}
.mc-pill input[type=text]:focus{border-bottom-color:currentColor}
`

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface PanelProps {
  api: ApiClient
  t: Translator
}

function ModelCapabilitiesPanel({ api, t }: PanelProps): React.ReactElement {
  const [providers, setProviders] = React.useState<ProviderView[]>([])
  const [route, setRoute] = React.useState<string>('')
  const [revision, setRevision] = React.useState<number | undefined>(undefined)
  // Detections (and manual edits) are keyed by provider route so switching
  // back and forth does not lose work.
  const [detectionsByRoute, setDetectionsByRoute] = React.useState<Record<string, Record<string, DetectionResult>>>({})
  const [busy, setBusy] = React.useState<boolean>(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<boolean>(false)
  const [justSaved, setJustSaved] = React.useState<boolean>(false)
  // Which level pills have their wire-spelling editor open (keys: `${id}:${level}`).
  const [editingLevels, setEditingLevels] = React.useState<Set<string>>(new Set())
  const savedTimer = React.useRef<number | undefined>(undefined)
  const detectedOnce = React.useRef<Set<string>>(new Set())

  React.useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const selected: ProviderView | null = providers.find((p) => p.route === route) ?? null
  const detections: Record<string, DetectionResult> = detectionsByRoute[route] ?? {}

  const setRouteDetections = React.useCallback((r: string, next: Record<string, DetectionResult>): void => {
    setDetectionsByRoute((prev) => ({ ...prev, [r]: next }))
  }, [])

  const load = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const value = unwrap(await api.settings.describe({}))
      const view = value.namespaces.find((n) => n && n.ns === NS)
      if (!view) throw new Error(t('errNotLoaded'))
      const list = providersOf(view)
      setProviders(list)
      setRevision(typeof view.revision === 'number' ? view.revision : undefined)
      setRoute((current) => (list.some((p) => p.route === current) ? current : (list[0]?.route ?? '')))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, t])

  const runDetect = React.useCallback(async (manual = false): Promise<void> => {
    if (!selected) return
    const currentRoute = selected.route
    setBusy(true)
    setError(null)
    setNotice(null)
    setSaved(false)
    try {
      let known: Map<string, { levels: string[]; defaultEffort?: string }> | undefined
      try {
        const cat = unwrap(await api.llm.models({}))
        known = knownReasoningOf(cat).get(currentRoute)
      } catch {
        known = undefined
      }

      const raw = await fetchRawModels(currentRoute)
      if (raw.data !== undefined) {
        const entries = new Map<string, ApiModelEntry>(raw.data.map((entry) => [String(entry?.id ?? ''), entry]))
        const next: Record<string, DetectionResult> = {}
        for (const m of selected.models) {
          const id = (m as { id: string }).id
          const merged = mergeCatalogInto(detectModel(id, entries.get(id)), known?.get(id))
          const echoed = withConfiguredBaseline(merged, m)
          next[id] = echoed.found ? echoed : { ...echoed, note: t('noteMissing') }
        }
        const configured = new Set<string>(selected.models.map((m) => (m as { id: string }).id))
        for (const [id, entry] of entries) {
          if (id.length === 0 || configured.has(id)) continue
          const det = mergeCatalogInto(detectModel(id, entry), known?.get(id))
          next[id] = { ...det, note: t('noteNew') }
        }
        setRouteDetections(currentRoute, next)
        return
      }

      // Fallback: official discovery (capacities only, no reasoning signals)
      let discovered: DiscoveredModel[] | undefined
      let discoverError: string | undefined
      try {
        const value = unwrap(await api.llm.discoverModels({ settingsNs: NS, provider: currentRoute }))
        discovered = value.models
      } catch (e) {
        discoverError = e instanceof Error ? e.message : String(e)
      }

      if (discovered !== undefined) {
        const found = new Map<string, DiscoveredModel>(discovered.map((m) => [m.id, m]))
        const next: Record<string, DetectionResult> = {}
        for (const m of selected.models) {
          const id = (m as { id: string }).id
          const entry = found.get(id)
          const info = known?.get(id)
          const detected: DetectionResult = entry
            ? {
                id,
                found: true,
                reasoning: info ? true : 'unknown',
                reasoningSource: info ? 'llm catalog' : undefined,
                reasoningEfforts: info ? defaultManualEfforts(info.levels) : undefined,
                vision: 'unknown',
                confidence: info ? 'medium' : 'low',
                contextWindow: entry.contextWindow,
                maxTokens: entry.maxTokens,
                name: entry.name,
              }
            : {
                id,
                found: false,
                reasoning: 'unknown',
                vision: 'unknown',
                confidence: 'low',
                note: t('noteMissing'),
              }
          next[id] = withConfiguredBaseline(detected, m)
        }
        const configured = new Set<string>(selected.models.map((m) => (m as { id: string }).id))
        for (const [id, entry] of found) {
          if (configured.has(id)) continue
          const info = known?.get(id)
          next[id] = {
            id,
            found: true,
            reasoning: info ? true : 'unknown',
            reasoningSource: info ? 'llm catalog' : undefined,
            reasoningEfforts: info ? defaultManualEfforts(info.levels) : undefined,
            vision: 'unknown',
            confidence: info ? 'medium' : 'low',
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxTokens,
            name: entry.name,
            note: t('noteNew'),
          }
        }
        setRouteDetections(currentRoute, next)
        setNotice(fmt(t('rawFallbackNote'), { detail: raw.error ?? '' }))
        return
      }

      // Neither source is reachable (no baseURL, no shipped catalog — e.g.
      // pure gateway routes): echo the saved configuration instead of erroring,
      // so the page still reflects current state. A manual re-detect gets a
      // soft notice explaining why there is nothing to probe.
      const echo: Record<string, DetectionResult> = {}
      for (const m of selected.models) {
        const id = (m as { id: string }).id
        echo[id] = withConfiguredBaseline(
          { id, found: false, reasoning: 'unknown', vision: 'unknown', confidence: 'low' },
          m,
        )
      }
      setRouteDetections(currentRoute, echo)
      if (manual) setNotice(fmt(t('detectUnavailable'), { detail: discoverError ?? raw.error ?? '' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, t, selected, setRouteDetections])

  React.useEffect(() => {
    void load()
  }, [load])

  // Auto-detect once per provider route (manual edits survive switching).
  React.useEffect(() => {
    if (!selected) return
    const r = selected.route
    if (detectedOnce.current.has(r)) return
    detectedOnce.current.add(r)
    void runDetect(false)
  }, [selected, runDetect])

  const onRouteChange = (value: string): void => {
    setRoute(value)
    setError(null)
    setNotice(null)
    setSaved(false)
  }

  const updateDetection = (id: string, patch: (cur: DetectionResult) => DetectionResult): void => {
    if (!selected) return
    const r = selected.route
    setDetectionsByRoute((prev) => {
      const curMap = prev[r] ?? {}
      const cur: DetectionResult = curMap[id] ?? {
        id,
        found: true,
        reasoning: 'unknown',
        vision: 'unknown',
        confidence: 'low',
      }
      return { ...prev, [r]: { ...curMap, [id]: patch(cur) } }
    })
  }

  const setEffort = (id: string, level: string, value: string | null | undefined): void => {
    updateDetection(id, (cur) => {
      const efforts: ReasoningEfforts = { ...(cur.reasoningEfforts ?? {}) }
      // undefined removes the level; null is the legal wire value for `off`.
      if (value === undefined) delete (efforts as Record<string, string | null | undefined>)[level]
      else (efforts as Record<string, string | null>)[level] = value
      return { ...cur, reasoningEfforts: efforts }
    })
  }

  const toggleReasoning = (id: string, enabled: boolean): void => {
    updateDetection(id, (cur) => {
      const knownEfforts = cur.reasoning === true && cur.reasoningEfforts ? cur.reasoningEfforts : undefined
      const efforts: ReasoningEfforts | undefined = enabled ? (knownEfforts ?? defaultManualEfforts()) : undefined
      return { ...cur, reasoningEfforts: efforts, reasoning: enabled ? 'manual' : 'off' }
    })
  }

  const resetEfforts = (id: string): void => {
    updateDetection(id, (cur) => ({ ...cur, reasoning: 'manual', reasoningEfforts: defaultManualEfforts() }))
  }

  const toggleLevelEditor = (id: string, level: string, open?: boolean): void => {
    setEditingLevels((prev) => {
      const key = `${id}:${level}`
      const next = new Set(prev)
      const shouldOpen = open ?? !next.has(key)
      if (shouldOpen) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const apply = async (): Promise<void> => {
    if (!selected) return
    if (revision === undefined) {
      setError(t('errNotLoaded'))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      if (Object.keys(detections).length === 0) {
        setError(t('errNothingToApply'))
        return
      }

      // Merge detections into existing models. `input` (vision) is never
      // written or removed — cloneJson carries any official-UI value through.
      const nextModels: Array<Record<string, unknown>> = selected.models.map((m) => {
        const id = (m as { id: string }).id
        const det = detections[id]
        const out = cloneJson(m) as Record<string, unknown>
        if (!det) return out
        if (det.reasoningEfforts !== undefined) {
          const enabled = Object.keys(det.reasoningEfforts)
          out.reasoningEfforts = enabled.length === 0 ? false : cloneJson(det.reasoningEfforts)
        } else if (det.reasoning === 'off') {
          out.reasoningEfforts = false
        }
        if (det.contextWindow !== undefined) out.contextWindow = det.contextWindow
        if (det.maxTokens !== undefined) out.maxTokens = det.maxTokens
        if (det.name !== undefined) out.name = det.name
        return out
      })

      // Append models advertised by the endpoint but not configured yet.
      const configured = new Set<string>(selected.models.map((m) => (m as { id: string }).id))
      for (const id of Object.keys(detections)) {
        if (configured.has(id)) continue
        const det = detections[id]
        if (!det.found && det.reasoning === 'unknown') continue
        const entry: Record<string, unknown> = { id }
        if (det.name !== undefined) entry.name = det.name
        if (det.contextWindow !== undefined) entry.contextWindow = det.contextWindow
        if (det.maxTokens !== undefined) entry.maxTokens = det.maxTokens
        if (det.reasoningEfforts !== undefined) {
          const enabled = Object.keys(det.reasoningEfforts)
          entry.reasoningEfforts = enabled.length === 0 ? false : cloneJson(det.reasoningEfforts)
        } else if (det.reasoning === false) {
          entry.reasoningEfforts = false
        }
        nextModels.push(entry)
      }

      const view = unwrap(
        await api.settings.mutate({
          ns: NS,
          ops: [{ op: 'set', path: ['providers', selected.route, 'models'], value: nextModels }],
          expectedRevision: revision,
        }),
      )
      setRevision(typeof view.revision === 'number' ? view.revision : undefined)
      setSaved(true)
      setJustSaved(true)
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setJustSaved(false), 2500)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const configuredIds: string[] = selected ? selected.models.map((m) => (m as { id: string }).id) : []
  const models: string[] = Array.from(new Set<string>([...configuredIds, ...Object.keys(detections)]))
  const hasDetections = Object.keys(detections).length > 0

  return (
    <div className="mc-root">
      <h2 className="mc-title">{t('title')}</h2>
      <p className="mc-intro">{t('intro')}</p>
      <div className="mc-toolbar">
        <select
          className="mc-select"
          value={route}
          disabled={busy}
          onChange={(e) => onRouteChange(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p.route} value={p.route}>
              {p.displayName} ({p.route})
            </option>
          ))}
        </select>
        <span className="mc-spacer" />
        <button className="mc-btn ghost" onClick={() => void runDetect(true)} disabled={busy || !selected}>
          {busy ? t('working') : hasDetections ? t('redetect') : t('detect')}
        </button>
      </div>
      {error ? <p className="mc-err">{error}</p> : null}
      {notice ? <p className="mc-note">{notice}</p> : null}
      {saved ? <p className="mc-ok">{fmt(t('saved'), { route })}</p> : null}
      {!selected ? <p className="mc-intro">{t('noProviders')}</p> : null}
      <ul className="mc-list">
        {models.map((id) => {
          const det = detections[id]
          const configured = selected?.models.find((m) => (m as { id: string }).id === id) as
            | (Record<string, unknown> & { reasoningEfforts?: unknown })
            | undefined
          const configuredEfforts = configured?.reasoningEfforts as ReasoningEfforts | false | undefined

          const rBadge = det ? (
            det.reasoning === true || det.reasoning === 'manual' ? (
              <span className="mc-badge yes">{t('badgeReasoning')}</span>
            ) : det.reasoning === 'off' || det.reasoning === false ? (
              <span className="mc-badge">{t('badgeOff')}</span>
            ) : (
              <span className="mc-badge">{t('badgeUnknown')}</span>
            )
          ) : configuredEfforts !== undefined ? (
            configuredEfforts === false ? (
              <span className="mc-badge">{t('badgeOff')}</span>
            ) : (
              <span className="mc-badge yes">{t('badgeReasoning')}</span>
            )
          ) : null

          const reasoningEnabled = !!det && det.reasoningEfforts !== undefined
          const efforts: ReasoningEfforts = reasoningEnabled ? (det.reasoningEfforts as ReasoningEfforts) : {}

          const cap: string[] = []
          const ctxWindow = det?.contextWindow ?? (configured?.contextWindow as number | undefined)
          const out = det?.maxTokens ?? (configured?.maxTokens as number | undefined)
          if (ctxWindow) cap.push(fmt(t('capCtx'), { n: Math.round(ctxWindow / 1000) }))
          if (out) cap.push(fmt(t('capOut'), { n: Math.round(out / 1000) }))

          return (
            <li key={id} className="mc-card">
              <div className="mc-head">
                <span className="mc-id">{id}</span>
                {det?.name || (configured?.name as string | undefined) ? (
                  <span className="mc-name">{String(det?.name ?? (configured?.name as string | undefined))}</span>
                ) : null}
                <span className="mc-head-badges">
                  {rBadge}
                  {det?.reasoningSource === 'endpoint' || det?.reasoningSource === 'llm catalog' ? (
                    <span className="mc-src">
                      {det.reasoningSource === 'endpoint' ? t('srcEndpoint') : t('srcCatalog')}
                    </span>
                  ) : null}
                  {!configured ? <span className="mc-badge new">{t('badgeNotConfigured')}</span> : null}
                </span>
              </div>
              {cap.length ? <div className="mc-cap">{cap.join(' · ')}</div> : null}
              {det?.note ? <div className="mc-note">{det.note}</div> : null}
              <div className="mc-divider" />
              <div className="mc-switch-row">
                <label className="mc-switch-label">
                  <span className="mc-switch">
                    <input
                      type="checkbox"
                      checked={reasoningEnabled}
                      disabled={busy}
                      onChange={(e) => toggleReasoning(id, e.target.checked)}
                    />
                    <span className="mc-track">
                      <span className="mc-knob" />
                    </span>
                  </span>
                  <span>{t('offerLevels')}</span>
                </label>
                {reasoningEnabled ? (
                  <button className="mc-link" onClick={() => resetEfforts(id)} disabled={busy}>
                    {t('resetLevels')}
                  </button>
                ) : null}
              </div>
              {reasoningEnabled ? (
                <div className="mc-efforts">
                  <span className="mc-hint">{t('levelsHint')}</span>
                  <div className="mc-pills">
                    {THINKING_LEVELS.map((level) => {
                      const active = level in efforts
                      const editable = active && level !== 'off'
                      const editing = editable && editingLevels.has(`${id}:${level}`)
                      return (
                        <label key={level} className={active ? 'mc-pill active' : 'mc-pill'}>
                          <input
                            type="checkbox"
                            checked={active}
                            disabled={busy}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setEffort(id, level, level === 'off' ? null : level)
                              } else {
                                setEffort(id, level, undefined)
                                toggleLevelEditor(id, level, false)
                              }
                            }}
                          />
                          <span>{level}</span>
                          {editable ? (
                            <button
                              type="button"
                              className={editing ? 'mc-pill-edit on' : 'mc-pill-edit'}
                              disabled={busy}
                              aria-label={t('editLevel')}
                              title={t('editLevel')}
                              onClick={() => toggleLevelEditor(id, level)}
                            >
                              <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                                <path
                                  d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                                  fill="currentColor"
                                />
                              </svg>
                            </button>
                          ) : null}
                          {editing ? (
                            <input
                              type="text"
                              value={efforts[level as keyof ReasoningEfforts] ?? ''}
                              disabled={busy}
                              autoFocus
                              onChange={(e) => setEffort(id, level, e.target.value)}
                            />
                          ) : null}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {models.length > 0 ? (
        <div className="mc-footer">
          <span className="mc-count">{fmt(t('modelCount'), { n: models.length })}</span>
          <span className="mc-spacer" />
          <button
            className="mc-btn"
            onClick={() => void apply()}
            disabled={busy || !selected || !hasDetections}
          >
            {busy ? t('working') : justSaved ? t('savedDone') : t('apply')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const locale = ctx.get('locale')
    locale?.register(LOCALE_NS, { zh, en })
    const t = locale?.bind(LOCALE_NS) ?? fallbackT

    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-llm-capabilities'
    style.textContent = CSS
    document.head.appendChild(style)
    const remote = ctx.get('remote')
    const api = remote ? createApiClient(remote) : undefined
    const slots = ctx.get('slots')
    const disposeSlot = slots?.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'model-capabilities',
          order: 11,
          label: () => t('nav'),
          inject: () => ({ api, t }),
        },
        ({ api, t: sectionT }: { api?: ApiClient; t?: Translator }) =>
          api && sectionT ? (
            <ModelCapabilitiesPanel api={api} t={sectionT} />
          ) : (
            <p className="mc-intro">{fallbackT('wireUnavailable')}</p>
          ),
      ),
    )
    return () => {
      disposeSlot?.()
      style.remove()
    }
  }, 'model-capabilities: settings section')
}

export const inject = ['slots', 'locale', 'remote', 'remote.llm', 'remote.session', 'remote.settings'] as const
export const name = 'dsh-llm-capabilities'
