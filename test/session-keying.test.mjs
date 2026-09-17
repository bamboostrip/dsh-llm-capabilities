/**
 * Conversation-scoped OpenCode session keying tests.
 * Run with `pnpm build && node test/session-keying.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  DERIVE_VERSION,
  NAMESPACE_CHAT,
  deriveOpenCodeSession,
  purposeNamespace,
  createRequestContext,
  resolveOpenCodeSession,
  rebindAsyncIterable,
} from '../dist/session-headers.js'

function ok(msg) {
  console.log(`✓ ${msg}`)
}

// Deterministic derivation — same input always same output
{
  const a = deriveOpenCodeSession('sess_abc', NAMESPACE_CHAT)
  const b = deriveOpenCodeSession('sess_abc', NAMESPACE_CHAT)
  assert.equal(a, b)
  assert.match(a, /^ses_[0-9a-f]{32}$/)
  ok('deriveOpenCodeSession is deterministic and official-shaped')
}

// Different conversation → different OpenCode session
{
  const a = deriveOpenCodeSession('sess_a', NAMESPACE_CHAT)
  const b = deriveOpenCodeSession('sess_b', NAMESPACE_CHAT)
  assert.notEqual(a, b)
  ok('different dsh sessions derive different OpenCode sessions')
}

// Namespace isolation (session-title only; compaction shares chat on purpose)
{
  const chat = deriveOpenCodeSession('sess_x', NAMESPACE_CHAT)
  const title = deriveOpenCodeSession('sess_x', 'aux:session-title')
  const compact = deriveOpenCodeSession('sess_x', NAMESPACE_CHAT)
  assert.notEqual(chat, title)
  assert.equal(chat, compact)
  ok('session-title is isolated; compaction rides the chat namespace (encrypted_content replay)')
}

// purposeNamespace mapping
{
  assert.equal(purposeNamespace(undefined), NAMESPACE_CHAT)
  assert.equal(purposeNamespace('session-title'), 'aux:session-title')
  assert.equal(purposeNamespace('compaction'), NAMESPACE_CHAT)
  assert.equal(purposeNamespace('anything-else'), NAMESPACE_CHAT)
  ok('purposeNamespace maps loop purposes to derive namespaces')
}

// Version prefix is part of the preimage (future-proof)
{
  assert.equal(DERIVE_VERSION, 'v1')
  ok('derive version is v1')
}

// ALS: concurrent contexts do not cross-talk
{
  const als = createRequestContext()
  const seen = []
  await Promise.all([
    als.run({ sessionId: 'sess_left', purpose: undefined, provider: 'ocg-r' }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      seen.push(['left', als.getStore()?.sessionId])
    }),
    als.run({ sessionId: 'sess_right', purpose: 'session-title', provider: 'ocg-c' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      seen.push(['right', als.getStore()?.sessionId, als.getStore()?.purpose])
    }),
  ])
  const left = seen.find((s) => s[0] === 'left')
  const right = seen.find((s) => s[0] === 'right')
  assert.equal(left?.[1], 'sess_left')
  assert.equal(right?.[1], 'sess_right')
  assert.equal(right?.[2], 'session-title')
  ok('AsyncLocalStorage isolates concurrent request contexts')
}

// resolveOpenCodeSession with conversation context
{
  const als = createRequestContext()
  const id = als.run({ sessionId: 'sess_main', purpose: undefined }, () => resolveOpenCodeSession(als))
  assert.equal(id, deriveOpenCodeSession('sess_main', NAMESPACE_CHAT))
  ok('resolve uses conversation sessionId when ALS is active')
}

// resolveOpenCodeSession with purpose only (no sessionId)
{
  const als = createRequestContext()
  const id = als.run({ purpose: 'compaction' }, () => resolveOpenCodeSession(als))
  assert.equal(id, deriveOpenCodeSession('process', 'chat:anon'))
  const title = als.run({ purpose: 'session-title' }, () => resolveOpenCodeSession(als))
  assert.equal(title, deriveOpenCodeSession('process', 'aux:session-title:anon'))
  ok('resolve without sessionId uses purpose-scoped process fallback')
}

// resolveOpenCodeSession without any context → process fallback
{
  const als = createRequestContext()
  const id = resolveOpenCodeSession(als)
  assert.equal(id, deriveOpenCodeSession('process', 'process'))
  assert.match(id, /^ses_[0-9a-f]{32}$/)
  ok('resolve without ALS uses stable process fallback')
}

// same conversation across "restarts" (new ALS instance, same sessionId) → same key
{
  const als1 = createRequestContext()
  const als2 = createRequestContext()
  const a = als1.run({ sessionId: 'sess_resume' }, () => resolveOpenCodeSession(als1))
  const b = als2.run({ sessionId: 'sess_resume' }, () => resolveOpenCodeSession(als2))
  assert.equal(a, b)
  ok('same dsh sessionId survives process restart (pure derivation)')
}

// rebindAsyncIterable: lazy generator that "fetches" on first pull still sees ALS
{
  const als = createRequestContext()
  const store = { sessionId: 'sess_lazy', purpose: undefined }
  const seen = []
  async function* lazyStream() {
    // first pull only — mimics adapter starting fetch on iteration
    seen.push(['pull', resolveOpenCodeSession(als)])
    yield 1
    seen.push(['pull2', resolveOpenCodeSession(als)])
    yield 2
  }
  const rebound = rebindAsyncIterable(lazyStream(), als, store)
  const out = []
  for await (const v of rebound) out.push(v)
  assert.deepEqual(out, [1, 2])
  assert.equal(seen[0][1], deriveOpenCodeSession('sess_lazy', NAMESPACE_CHAT))
  assert.equal(seen[1][1], deriveOpenCodeSession('sess_lazy', NAMESPACE_CHAT))
  ok('rebindAsyncIterable keeps ALS across lazy generator pulls')
}

// rebindAsyncIterable: non-iterable passthrough
{
  const als = createRequestContext()
  const notStream = { hello: 1 }
  assert.equal(rebindAsyncIterable(notStream, als, { sessionId: 'x' }), notStream)
  ok('rebindAsyncIterable ignores non-iterables')
}

// rebindAsyncIterable: frozen stream object survives (no rebind, no crash)
{
  const als = createRequestContext()
  const store = { sessionId: 'sess_frozen', purpose: undefined }
  async function* lazyStream() {
    yield 1
    yield 2
  }
  const stream = lazyStream()
  Object.freeze(stream)
  const rebound = rebindAsyncIterable(stream, als, store)
  assert.equal(rebound, stream)
  const out = []
  for await (const v of rebound) out.push(v)
  assert.deepEqual(out, [1, 2])
  ok('rebindAsyncIterable leaves frozen streams usable')
}

console.log('session-keying: all tests passed')
