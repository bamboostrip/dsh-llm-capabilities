/**
 * Client half of the DSH Model Capabilities plugin.
 *
 * Successor to dsh-reasoning-efforts. Registers one additive
 * `settings.section` page ("Model Capabilities") that lets the user
 * fix the two fields the official llm-pi-ai UI leaves unconfigurable
 * for self-hosted gateways:
 *   1. thinking levels  (reasoningEfforts)
 *   2. vision capability (input: ["text"] vs ["text","image"])
 *
 * Strict TS, no `any`. All wire types are locally declared.
 */

import * as React from 'react'
import type {
  ApiModelEntry,
  DetectionResult,
  InputModality,
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
  // pi-ai may expose inputModalities directly; treat as unknown and guard
  inputModalities?: readonly string[]
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
    '一处补齐自建模型在 llm-pi-ai 配置里缺的两块能力：思考档位（reasoningEfforts）和视觉能力（input）。目录已知的档位可一键预填；端点检测会填充上下文/输出容量、自动识别是否支持思考与图片，并列出服务商已提供但尚未配置的模型。保存将写入 llm-pi-ai 设置（providers.<route>.models）。',
  prefill: '从目录预填',
  detect: '从端点检测',
  apply: '应用到设置',
  working: '处理中…',
  modelCount: '{n} 个模型',
  saved: '已保存到 llm-pi-ai 设置（providers.{route}.models）。',
  noProviders: '在 llm-pi-ai 设置中未找到自定义服务商。',
  wireUnavailable: '设置通道不可用。',
  // reasoning
  offerLevels: '提供思考档位',
  badgeReasoning: '思考 ✓',
  badgeOff: '思考关闭',
  badgeUnknown: '未知',
  badgeNotConfigured: '未配置',
  // vision
  visionLabel: '视觉能力',
  visionInherit: '继承默认',
  visionOn: '支持图片',
  visionOff: '仅文本',
  badgeVision: '视觉 ✓',
  badgeTextOnly: '仅文本',
  // caps
  capCtx: '上下文 {n}K',
  capOut: '输出 {n}K',
  noteMissing: '模型未出现在端点列表中（请检查 API key，或该服务商不提供可用的 /models 列表）',
  noteNew: '端点已提供该模型但尚未配置；应用后会将其加入设置',
  srcEndpoint: '端点',
  srcCatalog: '目录',
  rawFallbackNote: '原始 /models 读取失败（{detail}），已回退官方发现通道（仅容量，不含推理/视觉信号）',
  errNotLoaded: 'llm-pi-ai 设置尚未加载',
  errNoCatalog: '模型目录没有该服务商的思考档位信息，请手动设置。',
  errNothingToApply: '没有可应用的内容：请先为至少一个模型启用思考档位或修改视觉能力。',
}

const en: Record<string, string> = {
  nav: 'Model Capabilities',
  title: 'Model Capabilities',
  intro:
    'Patch the two capabilities the official llm-pi-ai UI leaves unconfigurable for self-hosted gateways: thinking levels (reasoningEfforts) and vision (input). Catalog-known levels can be pre-filled; endpoint detection fills context/output capacities, auto-detects reasoning + image support, and lists models the provider advertises but settings do not configure yet. Saving writes to llm-pi-ai settings (providers.<route>.models).',
  prefill: 'Pre-fill from catalog',
  detect: 'Detect from endpoint',
  apply: 'Apply to settings',
  working: 'Working…',
  modelCount: '{n} models',
  saved: 'Saved to llm-pi-ai settings (providers.{route}.models).',
  noProviders: 'No providers found in llm-pi-ai settings.',
  wireUnavailable: 'Settings wire unavailable.',
  offerLevels: 'Offer thinking levels',
  badgeReasoning: 'reasoning ✓',
  badgeOff: 'reasoning off',
  badgeUnknown: 'unknown',
  badgeNotConfigured: 'not configured',
  visionLabel: 'Vision',
  visionInherit: 'inherit',
  visionOn: 'image ✓',
  visionOff: 'text-only',
  badgeVision: 'vision ✓',
  badgeTextOnly: 'text-only',
  capCtx: 'ctx {n}K',
  capOut: 'out {n}K',
  noteMissing:
    'model not present in the endpoint listing (check the API key, or the provider exposes no usable /models listing)',
  noteNew: 'advertised by the endpoint but not configured yet; applying will add it',
  srcEndpoint: 'endpoint',
  srcCatalog: 'catalog',
  rawFallbackNote:
    'raw /models read failed ({detail}); fell back to the official discovery channel (capacities only, no reasoning/vision signals)',
  errNotLoaded: 'llm-pi-ai settings not loaded yet',
  errNoCatalog: 'The model catalog reports no reasoning knowledge for this provider; set levels manually.',
  errNothingToApply: 'Nothing to apply: enable thinking levels or change vision on at least one model first.',
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

// Strict helper to read vision from catalog if exposed
function catalogVisionOf(group: CatalogModelEntry | undefined): InputModality[] | undefined {
  if (!group?.inputModalities) return undefined
  const mods = group.inputModalities.map((s) => s.toLowerCase())
  if (mods.includes('image')) return ['text', 'image']
  if (mods.includes('text')) return ['text']
  return undefined
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
.mc-root{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mc-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.mc-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.mc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-select{height:34px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-field-fill);color:var(--dsw-alias-label-primary);font:inherit;padding:0 10px;min-width:220px}
.mc-btn{height:34px;border:none;border-radius:17px;padding:0 16px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mc-btn:disabled{opacity:.55;cursor:default}
.mc-btn.ghost{background:var(--dsw-alias-button-secondary-fill);color:var(--dsw-alias-label-primary)}
.mc-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.mc-note{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.mc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.mc-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.mc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-id{font-size:14px;font-weight:500;line-height:22px}
.mc-name{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mc-badge{font-size:11px;line-height:16px;border-radius:4px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l3)}
.mc-badge.yes{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.mc-badge.no{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.mc-badge.unk{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}
.mc-badge.vision{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.mc-cap{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mc-toggle{display:flex;align-items:center;gap:6px;font-size:13px}
.mc-efforts{display:flex;flex-wrap:wrap;gap:6px}
.mc-chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:2px 8px}
.mc-chip input[type=text]{width:64px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;border-bottom:1px dashed var(--dsw-alias-border-l3)}
.mc-vision{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-vision label{font-size:13px;display:flex;align-items:center;gap:4px}
.mc-divider{height:1px;background:var(--dsw-alias-border-l2);margin:4px 0}
.mc-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0 2px;position:sticky;bottom:0;z-index:1;background:var(--dsw-alias-bg-primary,var(--dsw-alias-bg-page,#fff));border-top:1px solid var(--dsw-alias-border-l2);margin-top:4px}
.mc-footer-spacer{flex:1}
`

interface PanelProps {
  api: ApiClient
  t: Translator
}

function ModelCapabilitiesPanel({ api, t }: PanelProps): React.ReactElement {
  const [providers, setProviders] = React.useState<ProviderView[]>([])
  const [route, setRoute] = React.useState<string>('')
  const [revision, setRevision] = React.useState<number | undefined>(undefined)
  const [detections, setDetections] = React.useState<Record<string, DetectionResult>>({})
  const [busy, setBusy] = React.useState<boolean>(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<boolean>(false)

  const selected: ProviderView | null = providers.find((p) => p.route === route) ?? null

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
      setDetections({})
      setRoute((current) => (list.some((p) => p.route === current) ? current : (list[0]?.route ?? '')))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const onRouteChange = (value: string): void => {
    setRoute(value)
    setDetections({})
    setError(null)
    setNotice(null)
    setSaved(false)
  }

  const prefillFromCatalog = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setSaved(false)
    try {
      const catalog = unwrap(await api.llm.models({}))
      const known = knownReasoningOf(catalog).get(selected.route)
      const next: Record<string, DetectionResult> = {}
      for (const m of selected.models) {
        const id = (m as { id: string }).id
        const info = known?.get(id)
        // try to read vision from catalog if exposed
        const group = catalog.groups.find((g) => g.id === selected.route)
        const catEntry = group?.models.find((x) => x.id === id)
        const catVision = catalogVisionOf(catEntry)
        const vision: DetectionResult['vision'] =
          catVision?.includes('image' as InputModality) ? true : catVision ? false : 'unknown'
        next[id] = info
          ? {
              id,
              found: true,
              reasoning: true,
              reasoningSource: 'llm catalog',
              reasoningEfforts: defaultManualEfforts(info.levels),
              vision,
              visionSource: catVision ? 'llm catalog' : undefined,
              input: catVision,
              confidence: 'medium',
            }
          : {
              id,
              found: true,
              reasoning: 'unknown',
              vision,
              visionSource: catVision ? 'llm catalog' : undefined,
              input: catVision,
              confidence: 'low',
            }
      }
      setDetections(next)
      if (!known || known.size === 0) setError(t('errNoCatalog'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const detectAll = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setSaved(false)
    try {
      let known: Map<string, { levels: string[]; defaultEffort?: string }> | undefined
      let catalogGroups: CatalogValue | undefined
      try {
        const cat = unwrap(await api.llm.models({}))
        catalogGroups = cat
        known = knownReasoningOf(cat).get(selected.route)
      } catch {
        known = undefined
      }

      const raw = await fetchRawModels(selected.route)
      if (raw.data !== undefined) {
        const entries = new Map<string, ApiModelEntry>(raw.data.map((entry) => [String(entry?.id ?? ''), entry]))
        const next: Record<string, DetectionResult> = {}
        for (const m of selected.models) {
          const id = (m as { id: string }).id
          const merged = mergeCatalogInto(detectModel(id, entries.get(id)), known?.get(id))
          // enrich vision from catalog if raw was unknown
          if (merged.vision === 'unknown' && catalogGroups) {
            const g = catalogGroups.groups.find((x) => x.id === selected.route)
            const ce = g?.models.find((x) => x.id === id)
            const cv = catalogVisionOf(ce)
            if (cv) {
              merged.vision = cv.includes('image' as InputModality) ? true : false
              merged.visionSource = 'llm catalog'
              merged.input = cv
            }
          }
          next[id] = merged
        }
        const configured = new Set<string>(selected.models.map((m) => (m as { id: string }).id))
        for (const [id, entry] of entries) {
          if (id.length === 0 || configured.has(id)) continue
          const det = mergeCatalogInto(detectModel(id, entry), known?.get(id))
          next[id] = { ...det, note: det.found ? t('noteNew') : t('noteMissing') }
        }
        setDetections(next)
        return
      }

      // Fallback: official discovery (capacities only)
      const value = unwrap(await api.llm.discoverModels({ settingsNs: NS, provider: selected.route }))
      const found = new Map<string, DiscoveredModel>(value.models.map((m) => [m.id, m]))
      const next: Record<string, DetectionResult> = {}
      for (const m of selected.models) {
        const id = (m as { id: string }).id
        const entry = found.get(id)
        const info = known?.get(id)
        next[id] = entry
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
      setDetections(next)
      setNotice(fmt(t('rawFallbackNote'), { detail: raw.error ?? '' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const setEffort = (id: string, level: string, value: string | null | undefined): void => {
    setDetections((prev) => {
      const cur: DetectionResult = prev[id] ?? ({ id, found: true, reasoning: 'unknown', vision: 'unknown', confidence: 'low' } as DetectionResult)
      const efforts: ReasoningEfforts = { ...(cur.reasoningEfforts ?? {}) }
      if (value === undefined || value === null) delete (efforts as Record<string, string | null>)[level]
      else (efforts as Record<string, string | null>)[level] = value
      const next: DetectionResult = { ...cur, reasoningEfforts: efforts }
      return { ...prev, [id]: next }
    })
  }

  const toggleReasoning = (id: string, enabled: boolean): void => {
    setDetections((prev) => {
      const cur: DetectionResult = prev[id] ?? ({ id, found: true, reasoning: 'unknown', vision: 'unknown', confidence: 'low' } as DetectionResult)
      const knownEfforts = cur.reasoning === true && cur.reasoningEfforts ? cur.reasoningEfforts : undefined
      const efforts: ReasoningEfforts | undefined = enabled ? (knownEfforts ?? defaultManualEfforts()) : undefined
      const next: DetectionResult = {
        ...cur,
        reasoningEfforts: efforts,
        reasoning: enabled ? 'manual' : 'off',
      }
      return { ...prev, [id]: next }
    })
  }

  const setVision = (id: string, mode: 'inherit' | 'vision' | 'text-only'): void => {
    setDetections((prev) => {
      const cur: DetectionResult = prev[id] ?? ({ id, found: true, reasoning: 'unknown', vision: 'unknown', confidence: 'low' } as DetectionResult)
      let vision: DetectionResult['vision']
      let input: InputModality[] | undefined
      let visionSource: string | undefined
      if (mode === 'inherit') {
        vision = 'unknown'
        input = undefined
        visionSource = undefined
      } else if (mode === 'vision') {
        vision = 'manual'
        input = ['text', 'image']
        visionSource = 'manual'
      } else {
        vision = 'off'
        input = ['text']
        visionSource = 'manual'
      }
      const next: DetectionResult = { ...cur, vision, input, visionSource }
      return { ...prev, [id]: next }
    })
  }

  const apply = async (): Promise<void> => {
    if (!selected || revision === undefined) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      // collect ids where either reasoning or vision has been touched
      const touched = Object.keys(detections).filter((id) => {
        const d = detections[id]
        return d.reasoningEfforts !== undefined || d.input !== undefined || d.vision === 'off' || d.vision === 'manual'
      })
      // also include models where vision explicitly set to text-only/off (input defined)
      // if nothing touched, error
      if (touched.length === 0) {
        // check if any detection has been made at all (user may have detected but not changed)
        const hasDetections = Object.keys(detections).length > 0
        if (!hasDetections) {
          setError(t('errNothingToApply'))
          return
        }
        // If detections exist but no explicit edits, still allow applying detected vision/reasoning
        // So gather those where detection implies a write
        const implied = Object.keys(detections).filter((id) => {
          const d = detections[id]
          return d.vision === true || d.vision === false || d.reasoning === true
        })
        if (implied.length === 0) {
          setError(t('errNothingToApply'))
          return
        }
      }

      // Build next models: merge detections into existing models
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
        // vision: write input field
        if (det.input !== undefined) {
          out.input = cloneJson(det.input)
        } else if (det.vision === 'off') {
          out.input = ['text']
        } else if (det.vision === 'unknown' && det.visionSource === undefined) {
          // inherit: remove explicit input so it falls back to catalog/default
          delete out.input
        }
        if (det.contextWindow !== undefined) out.contextWindow = det.contextWindow
        if (det.maxTokens !== undefined) out.maxTokens = det.maxTokens
        if (det.name !== undefined) out.name = det.name
        return out
      })

      // Append new models advertised by endpoint but not yet configured, if they have any capability
      const configured = new Set<string>(selected.models.map((m) => (m as { id: string }).id))
      for (const id of Object.keys(detections)) {
        if (configured.has(id)) continue
        const det = detections[id]
        // only add if vision or reasoning or found
        if (!det.found && det.reasoning === 'unknown' && det.vision === 'unknown') continue
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
        if (det.input !== undefined) entry.input = cloneJson(det.input)
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
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const configuredIds: string[] = selected ? selected.models.map((m) => (m as { id: string }).id) : []
  const models: string[] = Array.from(new Set<string>([...configuredIds, ...Object.keys(detections)]))

  return (
    <div className="mc-root">
      <h2 className="mc-title">{t('title')}</h2>
      <p className="mc-intro">{t('intro')}</p>
      <div className="mc-row">
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
        <button className="mc-btn ghost" onClick={prefillFromCatalog} disabled={busy || !selected}>
          {t('prefill')}
        </button>
        <button className="mc-btn" onClick={detectAll} disabled={busy || !selected}>
          {busy ? t('working') : t('detect')}
        </button>
        <button className="mc-btn ghost" onClick={apply} disabled={busy || Object.keys(detections).length === 0}>
          {t('apply')}
        </button>
      </div>
      {error ? <p className="mc-err">{error}</p> : null}
      {notice ? <p className="mc-note">{notice}</p> : null}
      {saved ? <p className="mc-note">{fmt(t('saved'), { route })}</p> : null}
      {!selected ? <p className="mc-intro">{t('noProviders')}</p> : null}
      <ul className="mc-list">
        {models.map((id) => {
          const det = detections[id]
          const configured = selected?.models.find((m) => (m as { id: string }).id === id) as
            | (Record<string, unknown> & { input?: InputModality[]; reasoningEfforts?: unknown })
            | undefined
          const configuredInput = configured?.input as InputModality[] | undefined
          const configuredEfforts = configured?.reasoningEfforts as ReasoningEfforts | false | undefined

          // badge for reasoning
          const rBadge = det ? (
            det.reasoning === true || det.reasoning === 'manual' ? (
              <span className="mc-badge yes">{t('badgeReasoning')}</span>
            ) : det.reasoning === 'off' ? (
              <span className="mc-badge no">{t('badgeOff')}</span>
            ) : (
              <span className="mc-badge unk">{t('badgeUnknown')}</span>
            )
          ) : configuredEfforts !== undefined ? (
            configuredEfforts === false ? (
              <span className="mc-badge no">{t('badgeOff')}</span>
            ) : (
              <span className="mc-badge yes">{t('badgeReasoning')}</span>
            )
          ) : null

          // badge for vision
          const vBadge = (() => {
            // detection takes precedence
            if (det) {
              if (det.vision === true || det.vision === 'manual') return <span className="mc-badge vision">{t('badgeVision')}</span>
              if (det.vision === 'off') return <span className="mc-badge no">{t('badgeTextOnly')}</span>
              if (det.vision === 'unknown' && det.input?.includes('image')) return <span className="mc-badge vision">{t('badgeVision')}</span>
              return <span className="mc-badge unk">{t('badgeUnknown')}</span>
            }
            if (configuredInput) {
              return configuredInput.includes('image') ? (
                <span className="mc-badge vision">{t('badgeVision')}</span>
              ) : (
                <span className="mc-badge no">{t('badgeTextOnly')}</span>
              )
            }
            return <span className="mc-badge unk">{t('badgeUnknown')}</span>
          })()

          const reasoningEnabled = !!det && det.reasoningEfforts !== undefined
          const efforts: ReasoningEfforts = reasoningEnabled ? (det.reasoningEfforts as ReasoningEfforts) : {}

          // vision mode for select
          const visionMode: 'inherit' | 'vision' | 'text-only' = (() => {
            if (det) {
              if (det.vision === 'manual' || (det.vision === true && det.input?.includes('image'))) return 'vision'
              if (det.vision === 'off') return 'text-only'
              if (det.input === undefined && det.vision === 'unknown') return 'inherit'
              if (det.input?.includes('image')) return 'vision'
              if (det.input && !det.input.includes('image')) return 'text-only'
              return 'inherit'
            }
            if (configuredInput?.includes('image')) return 'vision'
            if (configuredInput && !configuredInput.includes('image')) return 'text-only'
            return 'inherit'
          })()

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
                {rBadge}
                {vBadge}
                {det?.reasoningSource === 'endpoint' || det?.reasoningSource === 'llm catalog' ? (
                  <span className="mc-name">{det.reasoningSource === 'endpoint' ? t('srcEndpoint') : t('srcCatalog')}</span>
                ) : null}
                {det?.visionSource === 'endpoint' || det?.visionSource === 'llm catalog' ? (
                  <span className="mc-name">{det.visionSource === 'endpoint' ? t('srcEndpoint') : t('srcCatalog')}</span>
                ) : null}
                {!configured ? <span className="mc-badge unk">{t('badgeNotConfigured')}</span> : null}
              </div>
              {cap.length ? <div className="mc-cap">{cap.join(' · ')}</div> : null}
              {det?.note ? <div className="mc-note">{det.note}</div> : null}

              {/* Vision */}
              <div className="mc-vision">
                <span style={{ fontSize: 13 }}>{t('visionLabel')}:</span>
                <label>
                  <input
                    type="radio"
                    name={`vision-${id}`}
                    checked={visionMode === 'inherit'}
                    disabled={busy}
                    onChange={() => setVision(id, 'inherit')}
                  />
                  {t('visionInherit')}
                </label>
                <label>
                  <input
                    type="radio"
                    name={`vision-${id}`}
                    checked={visionMode === 'vision'}
                    disabled={busy}
                    onChange={() => setVision(id, 'vision')}
                  />
                  {t('visionOn')}
                </label>
                <label>
                  <input
                    type="radio"
                    name={`vision-${id}`}
                    checked={visionMode === 'text-only'}
                    disabled={busy}
                    onChange={() => setVision(id, 'text-only')}
                  />
                  {t('visionOff')}
                </label>
              </div>

              <div className="mc-divider" />

              {/* Reasoning */}
              <label className="mc-toggle">
                <input
                  type="checkbox"
                  checked={reasoningEnabled}
                  disabled={busy}
                  onChange={(e) => toggleReasoning(id, e.target.checked)}
                />
                {t('offerLevels')}
              </label>
              {reasoningEnabled ? (
                <div className="mc-efforts">
                  {THINKING_LEVELS.map((level) => (
                    <label key={level} className="mc-chip">
                      <input
                        type="checkbox"
                        checked={level in efforts}
                        disabled={busy}
                        onChange={(e) =>
                          e.target.checked
                            ? setEffort(id, level, level === 'off' ? null : level)
                            : setEffort(id, level, undefined)
                        }
                      />
                      {level}
                      {level in efforts && level !== 'off' ? (
                        <input
                          type="text"
                          value={efforts[level as keyof ReasoningEfforts] ?? ''}
                          disabled={busy}
                          onChange={(e) => setEffort(id, level, e.target.value)}
                        />
                      ) : null}
                    </label>
                  ))}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {models.length > 0 ? (
        <div className="mc-footer">
          <span className="mc-name">{fmt(t('modelCount'), { n: models.length })}</span>
          <span className="mc-footer-spacer" />
          <button
            className="mc-btn"
            onClick={apply}
            disabled={busy || Object.keys(detections).length === 0}
          >
            {busy ? t('working') : t('apply')}
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
