import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunEnvelope, storedRunInput, unwrapRunPayload } from '../src/core/runEnvelope.ts'

test('run envelopes detach and freeze the complete reproducibility snapshot', () => {
  const result = { score: 42 }, settings = { iterations: 1000 }
  const envelope = createRunEnvelope({ kind: 'quick', appVersion: '0.1.0', input: 'mage="X"', settings,
    simulator: { build: '1234-01', sha256: 'a'.repeat(64) }, data: { itemTable: 'i', catalog: 'c', db2: 'd' }, warnings: ['partial coverage'], result })
  result.score = 7
  settings.iterations = 2
  assert.equal(envelope.result.score, 42)
  assert.equal(envelope.settings.iterations, 1000)
  assert.ok(Object.isFrozen(envelope.result))
  assert.equal(storedRunInput(envelope), 'mage="X"')
})

test('payload readers preserve legacy reports', () => {
  const legacy = { score: 17, input: 'legacy' }
  assert.equal(unwrapRunPayload<typeof legacy>(legacy), legacy)
  assert.equal(storedRunInput(legacy), 'legacy')
})
