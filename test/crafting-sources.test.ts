import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  embellishments, embellishmentLimit, db2,
  craftedItems, findCraftedItem, embellishmentSlots, embellishmentAllowedOn,
  gems, limitCategoryFor, assertGemCategoryLimits
} from '../src/core/data/db2.ts'
import { equipmentRestrictions } from '../src/core/data/embellish.ts'

/**
 * Locks the crafting evidence joins. These are
 * exact joins, not heuristics, so a regenerated table losing one is a defect
 * rather than drift — the picker would silently stop knowing where an
 * embellishment may go.
 */

test('every embellishment resolves to a crafting category', () => {
  const missing = embellishments().filter((e) => e.categoryId === null)
  assert.equal(missing.length, 0, `unresolved: ${missing.map((e) => e.name).join(', ')}`)
})

test('every embellishment resolves to its reagent item', () => {
  const missing = embellishments().filter((e) => e.reagentItemId === null)
  assert.equal(missing.length, 0, `no reagent item: ${missing.map((e) => e.name).join(', ')}`)
})

test('the category carries the game wording the restriction is read from', () => {
  for (const e of embellishments()) {
    assert.ok(e.categoryNote, `${e.name} has no category description to classify`)
  }
})

test('current-expansion embellishments all have a classified restriction', () => {
  const current = embellishments().filter((e) => e.expansion === 'Midnight')
  assert.ok(current.length > 0, 'no current-expansion embellishments at all')
  const unknown = current.filter((e) => e.appliesTo === 'unknown')
  assert.equal(unknown.length, 0, `unclassified: ${unknown.map((e) => e.name).join(', ')}`)
})

test('embellishments are not interchangeable across equipment', () => {
  // Domain knowledge, held as data: if every current embellishment shared one
  // restriction there would be nothing to enforce.
  const rules = new Set(embellishments().filter((e) => e.expansion === 'Midnight').map((e) => e.appliesTo))
  assert.ok(rules.size > 1, `expected several restrictions, got ${[...rules].join(', ')}`)
  assert.ok(rules.has('accessories'), 'the accessory-only restriction should be represented')
  assert.ok(rules.has('weapons_offhands'), 'the weapon/off-hand restriction should be represented')
})

test('the two-embellishment cap comes from the game, not a constant', () => {
  assert.equal(embellishmentLimit(), 2)
  const category = Object.entries(db2().limitCategories).find(([, c]) => c.name === 'Embellished')
  assert.ok(category, 'no Embellished limit category in the shipped table')
  assert.equal(category[1].quantity, embellishmentLimit())
})

test('craftable items are enumerated from recipes', () => {
  const all = craftedItems()
  assert.ok(all.length > 100, `only ${all.length} craftable items`)
  // Fixture #1's own crafted gear must be in there, or the recipe walk is wrong.
  for (const id of [244582, 245770]) {
    assert.ok(findCraftedItem(id), `crafted item ${id} is missing from the recipe walk`)
  }
  const slots = new Set(all.map((c) => c.slot))
  assert.ok(slots.has('finger') || slots.has('neck'), 'no craftable accessory found')
})

test('an embellishment is refused on a slot its recipes never produce', () => {
  const gun = embellishments().find((e) => e.appliesTo === 'guns')
  assert.ok(gun, 'no gun-restricted embellishment to test with')
  assert.equal(embellishmentAllowedOn(gun, 'chest'), false, 'a gun embellishment must not fit a chest')
  assert.equal(embellishmentAllowedOn(gun, 'ranged'), true)

  const accessory = embellishments().find((e) => e.appliesTo === 'accessories')
  assert.ok(accessory, 'no accessory-restricted embellishment to test with')
  assert.equal(embellishmentAllowedOn(accessory, 'finger1'), true, 'paired slots normalize')
  assert.equal(embellishmentAllowedOn(accessory, 'main_hand'), false)
})

test('an unclassified restriction yields no slots rather than every slot', () => {
  const invented = { ...embellishments()[0]!, appliesTo: 'something-new' }
  assert.deepEqual(embellishmentSlots(invented), [], 'unknown classes must fail closed')
})

test('a quantity-1 gem cannot be socketed twice in one item', () => {
  // The reproduction: Aqirbane Reliquary has two sockets,
  // and 240983 is ItemLimitCategory 698 "Thalassian Diamond", quantity 1.
  const category = limitCategoryFor(240983)
  assert.ok(category, 'gem 240983 has no limit category')
  assert.equal(category.quantity, 1)
  assert.throws(() => assertGemCategoryLimits([240983, 240983]), /Only 1 Thalassian Diamond/)
  // Two *different* gems of the same category are equally illegal.
  const sameCategory = gems()
    .flatMap((g) => g.tiers.map((t) => t.id))
    .filter((id) => limitCategoryFor(id)?.id === category.id)
  assert.ok(sameCategory.length >= 2, 'expected several gems in one category')
  assert.throws(() => assertGemCategoryLimits([sameCategory[0]!, sameCategory[1]!]), /Only 1/)
  // One is fine, and so are two gems that share no category.
  assert.doesNotThrow(() => assertGemCategoryLimits([240983]))
  const uncapped = gems().flatMap((g) => g.tiers.map((t) => t.id)).filter((id) => !limitCategoryFor(id))
  assert.ok(uncapped.length >= 2)
  assert.doesNotThrow(() => assertGemCategoryLimits([uncapped[0]!, uncapped[1]!]))
})

test('an item reports its gem categories for cross-item limits', () => {
  // Two rings each holding a quantity-1 gem must not both be wearable, which
  // the solver can only prevent if the item declares the category.
  const gemmed = {
    item: { id: 268266, tokens: [], bonusIds: [], gemIds: [240983], emittedSlot: 'finger1' },
    name: 'gemmed ring', ilvl: 331, slotClass: 'finger' as const, source: 'bags' as const
  }
  const categories = equipmentRestrictions(gemmed).categories
  assert.ok(categories.some((c) => c.key === '698' && c.limit === 1), JSON.stringify(categories))

  const plain = { ...gemmed, item: { ...gemmed.item, gemIds: [] } }
  assert.equal(equipmentRestrictions(plain).categories.some((c) => c.key === '698'), false)
})
