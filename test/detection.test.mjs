/**
 * Minimal detection tests for dsh-llm-capabilities, mirroring dsh-reasoning-efforts.
 * Run with `pnpm build && node test/detection.test.mjs`.
 */
import assert from 'node:assert/strict'
import { detectModel, analyzeVision, analyzeReasoning } from '../dist/detection.js'

function ok(msg) {
  console.log(`✓ ${msg}`)
}

// Reasoning: supported_features
{
  const det = detectModel('m1', { id: 'm1', supported_features: ['reasoning', 'tools'] })
  assert.equal(det.reasoning, true)
  assert.equal(det.reasoningSource, 'supported_features')
  ok('reasoning via supported_features')
}

// Reasoning: unknown when no signal
{
  const det = detectModel('m2', { id: 'm2', object: 'model' })
  assert.equal(det.reasoning, 'unknown')
  ok('reasoning unknown')
}

// Vision: modalities array
{
  const det = detectModel('v1', { id: 'v1', modalities: ['text', 'image'] })
  assert.equal(det.vision, true)
  assert.deepEqual(det.input, ['text', 'image'])
  ok('vision via modalities array')
}

// Vision: string modalities
{
  const r = analyzeVision({ id: 'x', modalities: 'text,image' })
  assert.equal(r.vision, true)
  ok('vision via modalities string')
}

// Vision: boolean flag
{
  const r = analyzeVision({ id: 'x', supports_vision: true })
  assert.equal(r.vision, true)
  assert.deepEqual(r.input, ['text', 'image'])
  ok('vision via supports_vision true')
  const r2 = analyzeVision({ id: 'x', supports_vision: false })
  assert.equal(r2.vision, false)
  assert.deepEqual(r2.input, ['text'])
  ok('vision via supports_vision false')
}

// Vision: input_modalities text-only
{
  const r = analyzeVision({ id: 'x', input_modalities: ['text'] })
  assert.equal(r.vision, false)
  ok('vision text-only via input_modalities')
}

// Vision: capabilities array
{
  const r = analyzeVision({ id: 'x', capabilities: ['vision'] })
  assert.equal(r.vision, true)
  ok('vision via capabilities array')
}

// Vision: supported_features containing vision
{
  const r = analyzeVision({ id: 'x', supported_features: ['tools', 'vision'] })
  assert.equal(r.vision, true)
  ok('vision via supported_features vision')
}

// Unified: both reasoning + vision
{
  const det = detectModel('both', { id: 'both', supported_features: ['reasoning', 'vision'] })
  assert.equal(det.reasoning, true)
  assert.equal(det.vision, true)
  ok('both reasoning+vision')
}

// Not found
{
  const det = detectModel('missing', undefined)
  assert.equal(det.found, false)
  assert.equal(det.reasoning, 'unknown')
  assert.equal(det.vision, 'unknown')
  ok('not found')
}

console.log('all detection tests passed')
