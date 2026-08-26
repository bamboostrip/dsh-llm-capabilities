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

export function apply(ctx: Context): void {
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
