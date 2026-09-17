/**
 * Host half of the DSH Model Capabilities plugin.
 *
 * Successor to dsh-reasoning-efforts. The client half drives everything
 * through the official wire, but one gap cannot be bridged that way:
 * the sanctioned `llm.discoverModels` endpoint narrows a provider's /models
 * listing to id/name/contextWindow/maxTokens host-side, stripping the
 * reasoning AND vision signals (supported_features, modalities, supports_vision…)
 * that rich listings carry. This half closes that gap with one same-origin web route:
 *
 *   GET /model-capabilities/raw-models?route=<llm-pi-ai route>
 *     → { ok: true, url, data: [<raw listing entries>] }
 *     → { ok: false, error }
 *
 * Keeps backward compat: also serves the legacy GET /thinking-levels/raw-models
 * so old dsh-reasoning-efforts clients keep working during migration.
 *
 * The route reads the provider's baseURL/apiKeyEnv from the `llm-pi-ai`
 * settings namespace, resolves the stored credential through the credentials
 * service, and fetches `{baseURL}/models` server-side (no CORS, no key
 * exposure — the reply never echoes the credential). Only routes already
 * configured in the user's own settings are reachable.
 * Browser trust fence mirrors /api route semantics.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_URL_PATTERNS,
  SESSION_HEADER,
  STABLE_PROCESS_KEY,
  createRequestContext,
  createSessionHeaderFetch,
  deriveOpenCodeSession,
  isSessionHeaderFetch,
  rebindAsyncIterable,
  resolveOpenCodeSession,
  type RequestContextStore,
} from './session-headers.js'

const NS = 'llm-pi-ai'
const ROUTE_PATH = '/model-capabilities/raw-models'
const LEGACY_ROUTE_PATH = '/thinking-levels/raw-models'
const FETCH_TIMEOUT_MS = 15_000

interface SettingsService {
  get(ns: string): unknown
}

interface CredentialsService {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

export interface SessionHeadersConfig {
  /** Default true. Set false to keep the plugin's capabilities UI while disabling header injection. */
  enabled?: boolean
  /** URL substring allowlist. Default `['opencode.ai/zen/go']` (covers ocg-c/ocg-r/ocg-a). */
  urlPatterns?: string[]
  /** Overriding the header name is not recommended; default is the Go-required name. */
  headerName?: string
  /**
   * Self-heal for stateless reasoning replay: on 400 "reasoning
   * `encrypted_content` was not issued to this caller", retry once with the
   * replayed encrypted reasoning items stripped. Default true.
   */
  encryptedContentRetry?: boolean
  /**
   * `conversation` (default): derive from dsh session id (restart-stable).
   * `process`: legacy process-lifetime single value.
   */
  keying?: 'conversation' | 'process'
}

export interface PluginConfig {
  sessionHeaders?: SessionHeadersConfig
}

interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function isTrustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const secFetchSite = req.headers['sec-fetch-site']
  if (secFetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const hostname = host.split(':')[0].toLowerCase()
  if (isLoopbackHostname(hostname)) return true
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site') return true
  return typeof origin === 'string'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function resolveApiKey(ctx: Context, apiKeyEnv: string | undefined): Promise<string | undefined> {
  if (!apiKeyEnv) return undefined
  try {
    const credentials = ctx.get('credentials') as CredentialsService | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyEnv)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      return undefined
    }
  } catch {
    // fall through to unauthenticated probe
  }
  return undefined
}

function makeHandler(ctx: Context, settings: SettingsService): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const route = url.searchParams.get('route') ?? ''
    const section = settings.get(NS)
    const providers = isRecord(section) ? section.providers : undefined
    const profile = isRecord(providers) ? providers[route] : undefined
    if (!isRecord(profile)) {
      sendJson(res, 400, { ok: false, error: `no llm-pi-ai provider route "${route}"` })
      return
    }
    const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : ''
    if (baseURL.length === 0) {
      sendJson(res, 400, { ok: false, error: `llm-pi-ai provider route "${route}" has no baseURL` })
      return
    }
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    const listingURL = baseURL.replace(/\/+$/, '') + '/models'
    const apiKey = await resolveApiKey(ctx, apiKeyEnv)
    try {
      const response = await fetch(listingURL, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        sendJson(res, 200, {
          ok: false,
          error: `${listingURL} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
        })
        return
      }
      const body = (await response.json()) as { data?: unknown }
      if (!body || !Array.isArray(body.data)) {
        sendJson(res, 200, { ok: false, error: `${listingURL} model listing has no "data" array` })
        return
      }
      sendJson(res, 200, { ok: true, url: listingURL, data: body.data })
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        error: `could not reach ${listingURL}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}

interface LlmStreamOptions {
  sessionId?: unknown
  purpose?: unknown
  provider?: unknown
  model?: unknown
}

function stampRequestContext(options: LlmStreamOptions | undefined): RequestContextStore {
  const sessionId =
    typeof options?.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : typeof options?.sessionId === 'number'
        ? String(options.sessionId)
        : undefined
  return {
    sessionId,
    purpose: typeof options?.purpose === 'string' ? options.purpose : undefined,
    provider: typeof options?.provider === 'string' ? options.provider : undefined,
    model: typeof options?.model === 'string' ? options.model : undefined,
  }
}

function registerSessionHeaders(ctx: Context, config: PluginConfig | undefined): void {
  if (config?.sessionHeaders?.enabled === false) return
  const keying = config?.sessionHeaders?.keying ?? 'conversation'
  ctx.effect(() => {
    const als = createRequestContext()
    const original = globalThis.fetch
    // Another copy of us (or a previous enable) already wrapped it: do not double-wrap.
    if (isSessionHeaderFetch(original)) return () => {}
    const patterns = config?.sessionHeaders?.urlPatterns ?? DEFAULT_URL_PATTERNS
    const headerName = config?.sessionHeaders?.headerName ?? SESSION_HEADER
    globalThis.fetch = createSessionHeaderFetch(original, {
      patterns,
      headerName,
      encryptedContentRetry: config?.sessionHeaders?.encryptedContentRetry !== false,
      getSessionId: () =>
        keying === 'process' ? deriveOpenCodeSession(STABLE_PROCESS_KEY, 'process') : resolveOpenCodeSession(als),
    })
    const restore = () => {
      // Restore only if ours is still the outermost wrapper: never break another plugin's chain.
      if (isSessionHeaderFetch(globalThis.fetch)) {
        globalThis.fetch = original
      }
    }

    // Conversation keying only: bridge llm/stream identity into ALS so fetch
    // (including lazy first-pull fetch) sees the dsh session id.
    // `global: true` matches dsh-session-title — plugin contexts without
    // inject('llm') still observe host waterfall events.
    let offStream: (() => unknown) | undefined
    if (keying !== 'process') {
      const on = (ctx as Context & {
        on?: (
          name: string,
          listener: (options: LlmStreamOptions, next: () => unknown) => unknown,
          options?: { global?: boolean },
        ) => (() => unknown) | unknown
      }).on
      if (typeof on === 'function') {
        const result = on.call(
          ctx,
          'llm/stream',
          (options: LlmStreamOptions, next: () => unknown) => {
            const store = stampRequestContext(options)
            return als.run(store, () => rebindAsyncIterable(next(), als, store))
          },
          { global: true },
        )
        if (typeof result === 'function') offStream = result as () => unknown
      }
    }

    return () => {
      offStream?.()
      restore()
    }
  }, 'model-capabilities: go session headers')
}

export function apply(ctx: Context, config?: PluginConfig): void {
  registerSessionHeaders(ctx, config)

  const settings = ctx.get('settings') as SettingsService | undefined
  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (settings === undefined || webServer === undefined) return

  const handler = makeHandler(ctx, settings)

  ctx.effect(
    () => webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'model-capabilities: raw-models route',
  )
  // Legacy compat for dsh-reasoning-efforts clients during migration
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: LEGACY_ROUTE_PATH, handler }),
    'model-capabilities: legacy raw-models route',
  )
}

export const inject = ['settings', 'webServer'] as const
export const name = 'dsh-llm-capabilities'
