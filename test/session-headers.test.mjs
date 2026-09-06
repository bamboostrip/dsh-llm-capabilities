/**
 * Session-header tests for dsh-llm-capabilities (Go affinity).
 * Run with `pnpm build && node test/session-headers.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  SESSION_HEADER,
  DEFAULT_URL_PATTERNS,
  newSessionId,
  shouldInject,
  createSessionIdStore,
  createSessionHeaderFetch,
  isSessionHeaderFetch,
} from '../dist/session-headers.js'

function ok(msg) {
  console.log(`✓ ${msg}`)
}

// URL matching
{
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/chat/completions'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/responses'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/models'), true)
  assert.equal(shouldInject('https://opencode.ai/zen/v1/chat/completions'), false)
  assert.equal(shouldInject('https://api.anthropic.com/v1/messages'), false)
  assert.equal(shouldInject('https://opencode.ai/zen/go/v1/chat/completions', ['']), false)
  ok('shouldInject matches only Go URLs, empty pattern never matches')
}

// Session ID shape + uniqueness
{
  const a = newSessionId()
  const b = newSessionId()
  assert.match(a, /^ses_[0-9a-f]{32}$/)
  assert.notEqual(a, b)
  ok('newSessionId shape + uniqueness')
}

// Store stability
{
  const store = createSessionIdStore()
  assert.equal(store.get('k'), store.get('k'))
  assert.notEqual(store.get('k1'), store.get('k2'))
  assert.equal(store.size, 3)
  store.clear('k1')
  assert.equal(store.size, 2)
  ok('store stable per key, isolated across keys')
}

// Wrapper sets header on match, string URL
{
  let seen
  const fake = async (input, init) => {
    seen = { url: input, headers: new Headers(init?.headers) }
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  assert.equal(isSessionHeaderFetch(patched), true)
  assert.equal(isSessionHeaderFetch(fake), false)
  await patched('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/probe', authorization: 'Bearer secret' },
  })
  assert.match(seen.headers.get(SESSION_HEADER) ?? '', /^ses_fixed$/)
  assert.equal(seen.headers.get('user-agent'), 'deepseek-harness/probe')
  assert.equal(seen.headers.get('authorization'), 'Bearer secret')
  ok('wrapper injects session header, preserves UA + auth')
}

// Wrapper passes through non-matching URLs untouched
{
  let calledInit
  const fake = async (input, init) => {
    calledInit = init
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  await patched('https://api.anthropic.com/v1/messages', { method: 'POST' })
  assert.equal(calledInit?.headers, undefined)
  ok('non-Go passthrough')
}

// Wrapper handles Request input
{
  let seen
  const fake = async (input) => {
    seen = new Headers(input.headers)
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  await patched(
    new Request('https://opencode.ai/zen/go/v1/responses', { headers: { 'user-agent': 'deepseek-harness/probe' } }),
  )
  assert.equal(seen.get(SESSION_HEADER), 'ses_fixed')
  assert.equal(seen.get('user-agent'), 'deepseek-harness/probe')
  ok('Request input cloned with header, UA intact')
}

// No session id -> passthrough
{
  let called = false
  const fake = async () => {
    called = true
    return new Response('{}')
  }
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => undefined })
  await patched('https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(called, true)
  ok('undefined session id passes through')
}

console.log('session-headers: all tests passed')
