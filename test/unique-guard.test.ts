import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUniqueRule, satisfiesUniqueRules } from '../src/core/data/unique.ts'
import { lookupItem } from '../src/core/data/itemTable.ts'

/**
 * These guard a case neither simc nor the Blizzard API protects:
 * simc will happily equip the same unique trinket in both slots and report
 * fabricated DPS for it. This code is the only check.
 */

test('two copies of a unique-equipped item are rejected', () => {
  const rule = parseUniqueRule('Unique-Equipped')
  assert.equal(rule.kind, 'item')
  assert.equal(satisfiesUniqueRules([{ id: 250214, rule }, { id: 250214, rule }]), false)
})

test('two different unique items are fine', () => {
  const rule = parseUniqueRule('Unique-Equipped')
  assert.equal(satisfiesUniqueRules([{ id: 250214, rule }, { id: 250215, rule }]), true)
})

test('two copies of a non-unique item are fine', () => {
  const rule = parseUniqueRule(undefined)
  assert.equal(rule.kind, 'none')
  assert.equal(satisfiesUniqueRules([{ id: 1, rule }, { id: 1, rule }]), true)
})

test('missing metadata fails closed, it is not treated as unrestricted', () => {
  assert.equal(satisfiesUniqueRules([{ id: 1, rule: undefined }]), false)
  assert.equal(satisfiesUniqueRules([{ id: 1, rule: { kind: 'unknown', raw: '???' } }]), false)
})

test('unrecognised unique text is unknown, never none', () => {
  const r = parseUniqueRule('Unique-Equipped: Something We Have Not Seen')
  assert.equal(r.kind, 'unknown')
})

test('category limits are enforced when present', () => {
  const rule = parseUniqueRule('Unique-Equipped: Embellished (2)')
  assert.equal(rule.kind, 'category')
  const three = [1, 2, 3].map((id) => ({ id, rule }))
  assert.equal(satisfiesUniqueRules(three.slice(0, 2)), true)
  assert.equal(satisfiesUniqueRules(three), false)
})

test('the bundled table really does flag the fixture trinket as unique', () => {
  // If this regresses, Top Gear could silently pair a unique trinket with itself.
  assert.equal(lookupItem(250214)?.unique?.kind, 'item')
})
