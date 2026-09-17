/**
 * OpenCode Go session-affinity headers (host half).
 *
 * OpenCode Go requires third-party agents to send a stable
 * `x-opencode-session` header so the gateway can optimize prompt caching
 * (see docs/go-session-header-background.md). This module wraps
 * `globalThis.fetch` and injects that header on matching URLs only.
 *
 * Deliberately does NOT touch `user-agent` / `authorization`: Go requires
 * honest client identification, and credentials belong to the llm-pi-ai
 * adapter. Only `x-opencode-session` (a non-conflicting header that the
 * attribution mechanism leaves alone) is set.
 *
 * The wrapper also self-heals the account-affinity rejection of stateless
 * reasoning replay: a 400 whose body says reasoning `encrypted_content` was
 * not issued to this caller means the gateway served the turn from a
 * different upstream account than the one that produced the encrypted
 * reasoning. The request is retried once with those replayed items stripped
 * (opt out via `encryptedContentRetry: false`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

/** Header name required by OpenCode Go for prompt-cache affinity. */
export const SESSION_HEADER = 'x-opencode-session'

/** Default URL substring allowlist: OpenCode Go endpoints only. */
export const DEFAULT_URL_PATTERNS: readonly string[] = ['opencode.ai/zen/go']

/**
 * Process-level fallback key when no conversation context is available
 * (title generation, compaction, hand-built probes). Used only as hash
 * input — the wire value is still derived, never this literal.
 */
export const STABLE_PROCESS_KEY = 'process'

/** Bump when the derivation preimage changes so cached bindings stay explicit. */
export const DERIVE_VERSION = 'v1'

/** Namespace for ordinary conversation / subagent turns. */
export const NAMESPACE_CHAT = 'chat' as const

/**
 * Map llm/stream `purpose` to a derive namespace. `session-title` is fully
 * isolated: it never replays conversation history. `compaction` deliberately
 * shares the chat namespace — it DOES replay history (including reasoning
 * items whose `encrypted_content` is bound to the account that issued them),
 * so it must ride the same gateway session affinity as the conversation or
 * the replay is rejected.
 */
export function purposeNamespace(purpose: string | undefined): string {
  if (purpose === 'session-title') return 'aux:session-title'
  return NAMESPACE_CHAT
}

/**
 * Deterministic OpenCode session id from a dsh conversation id.
 * Same conversation → same `ses_<32hex>` across restarts (pure function).
 */
export function deriveOpenCodeSession(dshSessionId: string, namespace: string = NAMESPACE_CHAT): string {
  const digest = createHash('sha256')
    .update(`dsh-llm-caps:${DERIVE_VERSION}:${namespace}:${dshSessionId}`)
    .digest('hex')
  return `ses_${digest.slice(0, 32)}`
}

/** Context stamped around one `llm/stream` call by the host half. */
export interface RequestContextStore {
  sessionId?: string
  purpose?: string
  provider?: string
  model?: string
}

export interface RequestContextHandle {
  run<T>(store: RequestContextStore, fn: () => T): T
  getStore(): RequestContextStore | undefined
}

/** Isolated ALS handle; one per plugin enable so HMR does not leak stores. */
export function createRequestContext(): RequestContextHandle {
  const als = new AsyncLocalStorage<RequestContextStore>()
  return {
    run<T>(store: RequestContextStore, fn: () => T): T {
      return als.run(store, fn)
    },
    getStore(): RequestContextStore | undefined {
      return als.getStore()
    },
  }
}

/**
 * Resolve the wire session id at fetch time.
 * Priority: conversation sessionId → purpose-scoped process fallback → process fallback.
 */
export function resolveOpenCodeSession(als: RequestContextHandle): string {
  const store = als.getStore()
  const purpose = purposeNamespace(store?.purpose)
  if (store?.sessionId !== undefined && store.sessionId.length > 0) {
    return deriveOpenCodeSession(store.sessionId, purpose)
  }
  if (store?.purpose !== undefined) {
    return deriveOpenCodeSession(STABLE_PROCESS_KEY, `${purpose}:anon`)
  }
  return deriveOpenCodeSession(STABLE_PROCESS_KEY, 'process')
}

/**
 * Re-bind ALS around every pull of an async iterable so lazy adapters that
 * `await fetch` on first `next()` still see the conversation context.
 */
export function rebindAsyncIterable<T>(
  stream: T,
  als: RequestContextHandle,
  store: RequestContextStore,
): T {
  if (stream === null || typeof stream !== 'object') return stream
  const target = stream as unknown as Record<PropertyKey, unknown>
  const asyncIterator = target[Symbol.asyncIterator]
  if (typeof asyncIterator !== 'function') return stream
  const originalIterator = (asyncIterator as () => AsyncIterator<unknown>).bind(stream)
  const patchedIterator = function patchedIterator(): AsyncIterator<unknown> {
    const it = originalIterator()
    const reenter = <R>(fn: () => Promise<R> | R): Promise<R> =>
      Promise.resolve(als.run(store, () => fn()))
    return {
      next: (...args: unknown[]) => reenter(() => it.next(...(args as []))),
      return: (...args: unknown[]) =>
        reenter(() =>
          it.return ? it.return(...(args as [])) : Promise.resolve({ done: true as const, value: undefined }),
        ),
      throw: (...args: unknown[]) =>
        reenter(() =>
          it.throw ? it.throw(...(args as [])) : Promise.reject(new Error('iterator does not support throw')),
        ),
    }
  }
  try {
    target[Symbol.asyncIterator] = patchedIterator
  } catch {
    // Frozen (or otherwise non-writable) stream object: keep it usable and
    // give up only the lazy-pull rebind guarantee.
    return stream
  }
  return stream
}

export type FetchFn = typeof fetch

export interface PatchOptions {
  patterns?: readonly string[]
  headerName?: string
  /** Return undefined to pass the request through untouched. */
  getSessionId: () => string | undefined
  /**
   * Self-heal for stateless reasoning replay across gateway accounts: when a
   * matching endpoint answers 400 "reasoning `encrypted_content` was not
   * issued to this caller", retry once with the replayed encrypted reasoning
   * items removed. Default true.
   */
  encryptedContentRetry?: boolean
}

/**
 * Stable substrings of the account-affinity rejection. The gateway wraps the
 * upstream message ("Upstream request failed: [invalid_request_error] …"),
 * so match the raw body instead of a fixed JSON shape.
 */
const ENCRYPTED_CONTENT_ERROR_MARKERS: readonly string[] = ['encrypted_content', 'was not issued to']

/**
 * True when `status`/`rawBody` is the gateway/OpenAI rejection of replayed
 * reasoning `encrypted_content` (signed for a different upstream account).
 */
export function isEncryptedContentCallerError(status: number, rawBody: string): boolean {
  if (status !== 400) return false
  const lowered = rawBody.toLowerCase()
  return ENCRYPTED_CONTENT_ERROR_MARKERS.every((marker) => lowered.includes(marker))
}

/**
 * Remove replayed stateless reasoning items that carry `encrypted_content`
 * from a Responses API payload (mutates `payload.input` in place). Returns
 * how many items were removed; 0 means there is nothing to heal. Whole items
 * are dropped rather than the field blanked — a content-less reasoning item
 * is itself an invalid replay.
 */
export function stripEncryptedReasoning(payload: unknown): number {
  if (payload === null || typeof payload !== 'object') return 0
  const source = payload as { input?: unknown }
  if (!Array.isArray(source.input)) return 0
  let removed = 0
  const kept: unknown[] = []
  for (const item of source.input) {
    if (isEncryptedReasoningItem(item)) {
      removed += 1
    } else {
      kept.push(item)
    }
  }
  if (removed > 0) source.input = kept
  return removed
}

function isEncryptedReasoningItem(item: unknown): boolean {
  if (item === null || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  return (
    record.type === 'reasoning' &&
    typeof record.encrypted_content === 'string' &&
    record.encrypted_content.length > 0
  )
}

function tryCloneRequest(request: Request): Request | undefined {
  try {
    return request.clone()
  } catch {
    return undefined
  }
}

async function safeText(request: Request): Promise<string | undefined> {
  try {
    return await request.text()
  } catch {
    return undefined
  }
}

/** True when `url` contains any non-empty pattern. Empty patterns never match. */
export function shouldInject(url: string, patterns: readonly string[] = DEFAULT_URL_PATTERNS): boolean {
  return patterns.some((p) => p.length > 0 && url.includes(p))
}

const WRAPPED_MARKER = Symbol.for('dsh-llm-capabilities.session-headers.wrapped')

export function isSessionHeaderFetch(fn: unknown): fn is FetchFn {
  if (typeof fn !== 'function') return false
  return (fn as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] === true
}

/**
 * Wrap `original` so matching requests carry the session header, and so a
 * gateway rejection of replayed encrypted reasoning is healed by retrying
 * once without those items. Handles string | URL | Request inputs; existing
 * headers (including any user-configured value) are overwritten on match
 * because a static config value would defeat per-session stability.
 * Non-matching URLs and undefined session ids pass through to `original`
 * untouched.
 */
export function createSessionHeaderFetch(original: FetchFn, options: PatchOptions): FetchFn {
  const patterns = options.patterns ?? DEFAULT_URL_PATTERNS
  const headerName = options.headerName ?? SESSION_HEADER
  const heal = options.encryptedContentRetry !== false
  const patched = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ): Promise<Response> => {
    const sessionId = options.getSessionId()
    if (sessionId === undefined) return original(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!shouldInject(url, patterns)) return original(input, init)

    const dispatch = (i: Parameters<FetchFn>[0], ini?: Parameters<FetchFn>[1]): Promise<Response> => {
      if (i instanceof Request) {
        const headers = new Headers(i.headers)
        headers.set(headerName, sessionId)
        return original(new Request(i, { headers }), ini)
      }
      const headers = new Headers(ini?.headers)
      headers.set(headerName, sessionId)
      return original(i, { ...ini, headers })
    }

    // The Request constructor proxies (and thereby disturbs) the source body,
    // so a replayable copy must be captured before dispatch.
    const replayable =
      heal && input instanceof Request && input.body !== null ? tryCloneRequest(input) : undefined

    const response = await dispatch(input, init)

    if (!heal || response.status !== 400) return response
    let errorText: string
    try {
      errorText = await response.clone().text()
    } catch {
      return response
    }
    if (!isEncryptedContentCallerError(response.status, errorText)) return response

    const initBody = init?.body
    const bodyText =
      typeof initBody === 'string'
        ? initBody
        : initBody instanceof Uint8Array
          ? new TextDecoder().decode(initBody)
          : replayable !== undefined
            ? await safeText(replayable)
            : undefined
    if (bodyText === undefined) return response
    let payload: unknown
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return response
    }
    if (stripEncryptedReasoning(payload) === 0) return response

    // Retry once: the healed payload no longer carries encrypted_content, so
    // this same rejection cannot recur from the retry.
    const retryBody = JSON.stringify(payload)
    if (input instanceof Request) {
      if (replayable === undefined) return response
      // Rebuild from the pristine clone; drop content-length so it matches
      // the healed body, and keep the caller's abort signal.
      const headers = new Headers(replayable.headers)
      headers.delete('content-length')
      headers.set(headerName, sessionId)
      return original(
        new Request(replayable.url, {
          method: replayable.method,
          headers,
          body: retryBody,
          signal: init?.signal ?? replayable.signal,
        }),
      )
    }
    const headers = new Headers(init?.headers)
    headers.delete('content-length')
    headers.set(headerName, sessionId)
    return original(input, { ...init, headers, body: retryBody })
  }) as FetchFn
  ;(patched as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] = true
  return patched
}
