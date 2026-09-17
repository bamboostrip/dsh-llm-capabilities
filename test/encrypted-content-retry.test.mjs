/**
 * Self-heal tests for the "reasoning `encrypted_content` was not issued to
 * this caller" gateway rejection (account affinity broke for one turn).
 * Run with `pnpm build && node test/encrypted-content-retry.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  SESSION_HEADER,
  isEncryptedContentCallerError,
  stripEncryptedReasoning,
  createSessionHeaderFetch,
} from '../dist/session-headers.js'

function ok(msg) {
  console.log(`✓ ${msg}`)
}

const GO_URL = 'https://opencode.ai/zen/go/v1/responses'

// The exact rejection shape reported from the field (gateway-wrapped) plus
// the plain upstream form.
const GATEWAY_400 = JSON.stringify({
  param: null,
  type: 'invalid_request_error',
  message:
    'Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller',
})

// A Responses payload that replays stateless reasoning across turns.
const PAYLOAD = {
  model: 'gpt-5',
  store: false,
  input: [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA-secret-1' },
    { type: 'reasoning', id: 'rs_store', summary: [] },
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
  ],
}

/** Fake fetch recording every call; `handler(callNo, call)` answers each. */
function fakeFetch(handler) {
  const calls = []
  const fn = async (input, init) => {
    const call = {
      isRequest: input instanceof Request,
      url: typeof input === 'string' ? input : input.url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: input instanceof Request ? input.headers : new Headers(init?.headers),
      body:
        input instanceof Request
          ? input.body === null
            ? undefined
            : await input.text()
          : typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : init?.body,
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    }
    calls.push(call)
    return handler(calls.length, call)
  }
  fn.calls = calls
  return fn
}

function go400(body) {
  return new Response(body ?? GATEWAY_400, { status: 400, headers: { 'content-type': 'application/json' } })
}

// isEncryptedContentCallerError
{
  assert.equal(isEncryptedContentCallerError(400, GATEWAY_400), true)
  assert.equal(isEncryptedContentCallerError(400, '{"error":{"message":"reasoning `encrypted_content` was not issued to this caller"}}'), true)
  assert.equal(isEncryptedContentCallerError(400, '{"message":"invalid api key"}'), false)
  assert.equal(isEncryptedContentCallerError(500, GATEWAY_400), false)
  assert.equal(isEncryptedContentCallerError(400, ''), false)
  ok('isEncryptedContentCallerError matches the rejection, only at 400')
}

// stripEncryptedReasoning
{
  const payload = structuredClone(PAYLOAD)
  assert.equal(stripEncryptedReasoning(payload), 1)
  assert.deepEqual(
    payload.input.map((i) => i.type),
    ['message', 'reasoning', 'function_call'],
  )
  assert.equal(payload.input[1].encrypted_content, undefined)
  assert.equal(stripEncryptedReasoning(payload), 0, 'idempotent')
  assert.equal(stripEncryptedReasoning({ input: 'hello' }), 0)
  assert.equal(stripEncryptedReasoning({ model: 'x' }), 0)
  assert.equal(stripEncryptedReasoning('nope'), 0)
  ok('stripEncryptedReasoning drops only encrypted reasoning items, idempotent')
}

// E2E init path: 400 rejection -> healed retry -> 200 reaches the caller
{
  let retryBody
  const fake = fakeFetch(async (n, call) => {
    if (n === 1) return go400()
    retryBody = JSON.parse(call.body)
    return new Response('{"ok":true}')
  })
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(GO_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(JSON.stringify(PAYLOAD).length),
      [SESSION_HEADER]: 'ses_stale',
    },
    body: JSON.stringify(PAYLOAD),
  })
  assert.equal(response.status, 200)
  assert.equal(fake.calls.length, 2)
  assert.deepEqual(
    retryBody.input.map((i) => i.type),
    ['message', 'reasoning', 'function_call'],
  )
  assert.equal(fake.calls[1].headers.get(SESSION_HEADER), 'ses_fixed')
  const cl = fake.calls[1].headers.get('content-length')
  if (cl !== null) assert.equal(Number(cl), Buffer.byteLength(JSON.stringify(retryBody)))
  ok('init path: rejected replay is retried once without encrypted reasoning')
}

// E2E init path with Uint8Array body
{
  const fake = fakeFetch(async (n) => (n === 1 ? go400() : new Response('{"ok":true}')))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(GO_URL, {
    method: 'POST',
    body: new TextEncoder().encode(JSON.stringify(PAYLOAD)),
  })
  assert.equal(response.status, 200)
  assert.equal(fake.calls.length, 2)
  assert.equal(JSON.parse(fake.calls[1].body).input.length, 3)
  ok('Uint8Array bodies are healed too')
}

// E2E Request path: retry is a rebuilt Request, cleaned and header-stamped
{
  const fake = fakeFetch(async (n) => (n === 1 ? go400() : new Response('{"ok":true}')))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(
    new Request(GO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/probe' },
      body: JSON.stringify(PAYLOAD),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(fake.calls.length, 2)
  const retry = fake.calls[1]
  assert.equal(retry.isRequest, true)
  assert.equal(retry.method, 'POST')
  assert.equal(retry.url, GO_URL)
  assert.equal(JSON.parse(retry.body).input.length, 3)
  assert.equal(retry.headers.get(SESSION_HEADER), 'ses_fixed')
  assert.equal(retry.headers.get('user-agent'), 'deepseek-harness/probe')
  ok('Request path: retry is a rebuilt Request with UA preserved')
}

// E2E Request path: caller abort signal rides the retry
{
  const controller = new AbortController()
  const fake = fakeFetch(async (n) => (n === 1 ? go400() : new Response('{"ok":true}')))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  await patched(
    new Request(GO_URL, { method: 'POST', body: JSON.stringify(PAYLOAD), signal: controller.signal }),
  )
  assert.equal(fake.calls.length, 2)
  controller.abort()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(fake.calls[1].signal?.aborted, true)
  ok('Request path: abort signal is wired through the retry')
}

// Non-matching 400 passes through untouched (single call)
{
  const fake = fakeFetch(async () => go400('{"message":"context length exceeded"}'))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(GO_URL, { method: 'POST', body: JSON.stringify(PAYLOAD) })
  assert.equal(response.status, 400)
  assert.equal(fake.calls.length, 1)
  assert.match(await response.text(), /context length exceeded/)
  ok('unrelated 400s pass through without retry')
}

// Matching 400 but nothing to strip -> pass through
{
  const fake = fakeFetch(async () => go400())
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(GO_URL, {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5', input: 'plain string' }),
  })
  assert.equal(response.status, 400)
  assert.equal(fake.calls.length, 1)
  ok('rejection without encrypted replay passes through (nothing to heal)')
}

// Retry answer is returned as-is — exactly one retry, no loop
{
  const fake = fakeFetch(async (n) => (n === 1 ? go400() : go400('{"message":"still bad"}')))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched(GO_URL, { method: 'POST', body: JSON.stringify(PAYLOAD) })
  assert.equal(response.status, 400)
  assert.equal(fake.calls.length, 2)
  ok('retry answer is passed through, never retried twice')
}

// encryptedContentRetry: false disables the heal entirely
{
  const fake = fakeFetch(async () => go400())
  const patched = createSessionHeaderFetch(fake, {
    getSessionId: () => 'ses_fixed',
    encryptedContentRetry: false,
  })
  const response = await patched(GO_URL, { method: 'POST', body: JSON.stringify(PAYLOAD) })
  assert.equal(response.status, 400)
  assert.equal(fake.calls.length, 1)
  ok('encryptedContentRetry: false keeps strict passthrough')
}

// Non-Go URLs are never healed
{
  const fake = fakeFetch(async () => new Response('{"message":"encrypted_content was not issued to"}', { status: 400 }))
  const patched = createSessionHeaderFetch(fake, { getSessionId: () => 'ses_fixed' })
  const response = await patched('https://api.other.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify(PAYLOAD),
  })
  assert.equal(response.status, 400)
  assert.equal(fake.calls.length, 1)
  ok('heal only applies to Go endpoints')
}

console.log('encrypted-content-retry: all tests passed')
