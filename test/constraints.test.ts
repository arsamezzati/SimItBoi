import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUniqueRule, satisfiesUniqueRules } from '../src/core/data/unique.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { inferConfig } from '../src/core/topgear/weapons.ts'
import { isLegalSingleSwap } from '../src/core/topgear/prepass.ts'
import { enumerateItemPairs } from '../src/core/topgear/pairs.ts'
import { itemTable } from '../src/core/data/itemTable.ts'

test('unique item restrictions cover different variants of the same id', () => {
  const rule = parseUniqueRule('Unique-Equipped')
  assert.equal(satisfiesUniqueRules([{ id: 1, rule }, { id: 1, rule }]), false)
  assert.equal(satisfiesUniqueRules([{ id: 1, rule }, { id: 2, rule }]), true)
  assert.equal(parseUniqueRule('Unique').kind, 'item')
})

test('category restrictions share limits across distinct items', () => {
  const rule = parseUniqueRule('Unique-Equipped: Test Category (1)')
  assert.equal(satisfiesUniqueRules([{ id: 1, rule }, { id: 2, rule }]), false)
  const two = parseUniqueRule('Unique-Equipped: Test Category (2)')
  assert.equal(satisfiesUniqueRules([{ id: 1, rule: two }, { id: 2, rule: two }]), true)
})

test('missing or unrecognized data is not unrestricted', () => {
  assert.equal(satisfiesUniqueRules([{ id: 1 }]), false)
  assert.equal(satisfiesUniqueRules([{ id: 1, rule: parseUniqueRule('unexpected') }]), false)
  assert.equal(satisfiesUniqueRules([{ id: 1, rule: parseUniqueRule(undefined) }]), true)
})

test('metadata distinguishes ranged weapons and incomplete one-hand setups', () => {
  const p = parseAddonProfile('hunter="H"\nspec=marksmanship\nmain_hand=,id=1\n')
  assert.equal(inferConfig(p, () => 'ranged'), 'ranged')
  assert.equal(inferConfig(p, () => 'one_hand'), 'unknown')
})

test('pre-pass rejects both directions of the phantom weapon swap', () => {
  const staff = parseAddonProfile('shaman="S"\nspec=elemental\nmain_hand=,id=245770\n')
  const pair = parseAddonProfile('shaman="S"\nspec=elemental\nmain_hand=,id=273778\noff_hand=,id=159664\n')
  assert.equal(isLegalSingleSwap(staff, pair.equipped[1]), false)
  assert.equal(isLegalSingleSwap(pair, staff.equipped[0]), false)
  assert.equal(isLegalSingleSwap(pair, pair.equipped[0]), true)
})

test('M6 pairs require two owned copies and preserve distinct bonus variants', () => {
  const p = parseAddonProfile('shaman="S"\nfinger1=,id=1,bonus_id=10\nfinger2=,id=1,bonus_id=20\n')
  const unrestricted = () => parseUniqueRule(undefined)
  assert.equal([...enumerateItemPairs(p.equipped.slice(0, 1), unrestricted)].length, 0)
  assert.equal([...enumerateItemPairs(p.equipped, unrestricted)].length, 1)
  assert.equal([...enumerateItemPairs(p.equipped, () => parseUniqueRule('Unique-Equipped'))].length, 0)
  assert.equal([...enumerateItemPairs(p.equipped, () => undefined)].length, 0)
  const copies = [p.equipped[0], { ...p.equipped[0] }, { ...p.equipped[0] }]
  assert.equal([...enumerateItemPairs(copies, unrestricted)].length, 1)
})

test('bundled table explicitly covers every ring and trinket', () => {
  const table = itemTable()
  assert.equal(table.version, 3)
  const paired = Object.entries(table.items).filter(([, row]) => ['FINGER', 'TRINKET'].includes(row[0]))
  assert.ok(paired.length > 8000)
  for (const [id] of paired) {
    assert.ok(table.unique?.[id], `Missing restriction metadata for ${id}`)
    assert.notEqual(table.unique[id].kind, 'unknown', `Unparsed restriction for ${id}`)
  }
})
