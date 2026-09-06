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
 */

import { randomBytes } from 'node:crypto'

/** Header name required by OpenCode Go for prompt-cache affinity. */
export const SESSION_HEADER = 'x-opencode-session'

/** Default URL substring allowlist: OpenCode Go endpoints only. */
export const DEFAULT_URL_PATTERNS: readonly string[] = ['opencode.ai/zen/go']

/**
 * v1 session key. One stable id per plugin lifetime: it satisfies the
 * official MUST (header present + stable, so caching works) with zero
 * dependence on undocumented session seams. Cache entries are still keyed
 * by content server-side, so sharing one id is never a correctness bug —
 * only slightly less precise than per-conversation ids. Per-conversation
 * keying is a follow-up once the session seam is confirmed (Task 1 step 3).
 */
export const STABLE_PROCESS_KEY = 'default'

export type FetchFn = typeof fetch

export interface PatchOptions {
  patterns?: readonly string[]
  headerName?: string
  /** Return undefined to pass the request through untouched. */
  getSessionId: () => string | undefined
}

/** Official CLI shape: `ses_` + 128-bit hex. */
export function newSessionId(): string {
  return `ses_${randomBytes(16).toString('hex')}`
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

export interface SessionIdStore {
  /** Stable id for `key`: generated once (`ses_<32hex>`), then reused. */
  get(key: string): string
  clear(key: string): void
  clearAll(): void
  readonly size: number
}

export function createSessionIdStore(): SessionIdStore {
  const map = new Map<string, string>()
  return {
    get(key: string): string {
      const hit = map.get(key)
      if (hit !== undefined) return hit
      const id = newSessionId()
      map.set(key, id)
      return id
    },
    clear(key: string): void {
      map.delete(key)
    },
    clearAll(): void {
      map.clear()
    },
    get size(): number {
      return map.size
    },
  }
}

/**
 * Wrap `original` so matching requests carry the session header.
 * Handles string | URL | Request inputs; existing headers (including any
 * user-configured value) are overwritten on match because a static config
 * value would defeat per-session stability. Non-matching URLs and
 * undefined session ids pass through to `original` untouched.
 */
export function createSessionHeaderFetch(original: FetchFn, options: PatchOptions): FetchFn {
  const patterns = options.patterns ?? DEFAULT_URL_PATTERNS
  const headerName = options.headerName ?? SESSION_HEADER
  const patched = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ): Promise<Response> => {
    const sessionId = options.getSessionId()
    if (sessionId === undefined) return original(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!shouldInject(url, patterns)) return original(input, init)
    if (input instanceof Request) {
      const headers = new Headers(input.headers)
      headers.set(headerName, sessionId)
      return original(new Request(input, { headers }), init)
    }
    const headers = new Headers(init?.headers)
    headers.set(headerName, sessionId)
    return original(input, { ...init, headers })
  }) as FetchFn
  ;(patched as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] = true
  return patched
}
