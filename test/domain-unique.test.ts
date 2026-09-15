import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { domainUniqueRule, resolveUniqueRule, parseUniqueRule } from '../src/core/data/unique.ts'
import { uniqueRuleFor, isCrafted, lookupItem } from '../src/core/data/itemTable.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'

/** Domain rules from game knowledge: crafted epics, and epic rings/trinkets. */

test('crafted epics are unique-equipped', () => {
  const r = domainUniqueRule({ quality: 'epic', inventoryType: 'LEGS', crafted: true })
  assert.equal(r?.kind, 'item')
  assert.equal(r?.limit, 1)
})

test('epic rings and trinkets are unique-equipped', () => {
  for (const inv of ['FINGER', 'TRINKET']) {
    const r = domainUniqueRule({ quality: 'epic', inventoryType: inv, crafted: false })
    assert.equal(r?.kind, 'item', `${inv} should be unique`)
  }
})

test('the rule does not over-reach to non-epic or other slots', () => {
  assert.equal(domainUniqueRule({ quality: 'rare', inventoryType: 'FINGER', crafted: false }), null)
  assert.equal(domainUniqueRule({ quality: 'epic', inventoryType: 'HEAD', crafted: false }), null)
  assert.equal(domainUniqueRule({ quality: 'uncommon', inventoryType: 'LEGS', crafted: true }), null)
})

test('a domain rule overrides an API "none" — restrictions are never downgraded', () => {
  const api = parseUniqueRule(undefined) // {kind:'none'} — what the API says for crafted epics
  assert.equal(api.kind, 'none')
  const resolved = resolveUniqueRule(api, { quality: 'epic', inventoryType: 'LEGS', crafted: true })
  assert.equal(resolved.kind, 'item')
})

test('an API category limit is kept, never replaced by the blunter domain rule', () => {
  const api = parseUniqueRule('Unique-Equipped: Embellished (2)')
  const resolved = resolveUniqueRule(api, { quality: 'epic', inventoryType: 'FINGER', crafted: true })
  assert.equal(resolved.kind, 'category')
  assert.equal(resolved.limit, 2)
})

test('absent metadata with no applicable rule still fails closed', () => {
  const r = resolveUniqueRule(undefined, { quality: 'rare', inventoryType: 'HEAD', crafted: false })
  assert.equal(r.kind, 'unknown')
})

test('crafted items are detected from the item string, not the id', () => {
  const p = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  const faulds = p.equipped.find((c) => c.item.id === 244582)
  const head = p.equipped.find((c) => c.item.id === 271483)
  assert.ok(faulds && head)
  assert.equal(isCrafted(faulds.item), true, 'crafted legs carry crafting_quality')
  assert.equal(isCrafted(head.item), false, 'tier head does not')
})

test('the fixture crafted epic legs now resolve as unique, where the API said nothing', () => {
  const p = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  const faulds = p.equipped.find((c) => c.item.id === 244582)!
  assert.equal(lookupItem(244582)?.quality, 'epic')
  assert.equal(lookupItem(244582)?.unique, undefined, 'API supplied no rule for this slot')
  assert.equal(uniqueRuleFor(faulds).kind, 'item')
})

test('the PvP trinkets the API missed are now covered by the rule', () => {
  // 270605 Venomous Gladiator's Medallion — epic trinket, no API unique flag,
  // category-limited in game.
  assert.equal(lookupItem(270605)?.quality, 'epic')
  const rule = domainUniqueRule({
    quality: lookupItem(270605)?.quality,
    inventoryType: lookupItem(270605)?.inventoryType,
    crafted: false
  })
  assert.equal(rule?.kind, 'item')
})
