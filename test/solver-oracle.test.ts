import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CandidateItem, SlotClass } from '../src/core/types.ts'
import type { ItemMeta } from '../src/core/data/itemTable.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { solveTopGear, type EquipmentRestrictions, type Gear, type SolverOptions } from '../src/core/topgear/solver.ts'

/**
 * Solver oracles. solver.test.ts already compares an unconstrained case
 * against exhaustive Cartesian enumeration. These cover the part that was not
 * checked: what the bounded search does once *constraints* are involved.
 *
 * Two kinds of assertion, deliberately separated:
 *
 * - an exhaustive comparison where the legal answer is small enough to count by
 *   hand, so the oracle cannot encode a misunderstanding of the solver; and
 * - safety properties over whatever the search returns. Those hold regardless of
 *   how enumeration is implemented, which is the point: an illegal set must
 *   never appear no matter how the shortlist was reached.
 */

const SLOT_INVENTORY: Record<string, string> = {
  head: 'HEAD', shoulder: 'SHOULDER', chest: 'CHEST', hands: 'HAND', legs: 'LEGS',
  neck: 'NECK', back: 'CLOAK', wrist: 'WRIST', waist: 'WAIST', feet: 'FEET',
  finger: 'FINGER', trinket: 'TRINKET'
}

function fixture() {
  const profile = parseAddonProfile('shaman="Test"\nspec=elemental\n')
  const metadata = new Map<number, ItemMeta>()
  const restrictions = new Map<CandidateItem, EquipmentRestrictions>()
  let nextId = 0

  /** `id` may be reused to create a second physical copy of one item. */
  function add(
    slot: SlotClass,
    score: number,
    options: { id?: number; meta?: Partial<ItemMeta>; embellishments?: number; categories?: Array<{ key: string; limit: number; uses?: number }> } = {}
  ): CandidateItem {
    const itemId = options.id ?? ++nextId
    const item: CandidateItem = {
      name: `item${itemId}#${score}`, ilvl: score, slotClass: slot, source: 'bags',
      item: {
        emittedSlot: slot, id: itemId, bonusIds: [score], gemIds: [],
        tokens: [{ key: 'id', value: String(itemId) }, { key: 'bonus_id', value: String(score) }]
      }
    }
    metadata.set(itemId, {
      inventoryType: SLOT_INVENTORY[slot] ?? 'TWOHWEAPON', itemClassId: 4, itemSubclassId: 0,
      armorClass: 'misc', unique: { kind: 'none' }, ...options.meta
    })
    restrictions.set(item, { categories: options.categories ?? [], embellishments: options.embellishments ?? 0 })
    profile.bagItems.push(item)
    return item
  }

  add('main_hand', 0, { meta: { weaponType: 'two_hand', itemClassId: 2 } })
  profile.equipped.push(profile.bagItems.pop()!)

  const options: SolverOptions = {
    shortlistSize: 50, ilvlFloor: 0, scoreItem: (c) => c.ilvl,
    lookup: (id) => metadata.get(id),
    rules: { configs: ['two_hand'], offHand: [], verified: true },
    eligibility: () => true,
    restrictions: (c) => restrictions.get(c) ?? { categories: [], embellishments: 0 }
  }
  return { profile, options, add }
}

const worn = (gear: Gear): CandidateItem[] => Object.values(gear).filter((i): i is CandidateItem => i !== null)

const UNIQUE = { unique: { kind: 'item' as const, limit: 1, raw: 'Unique-Equipped' } }

test('unique-equipped keys on item id, not on the item string', async () => {
  const f = fixture()
  // Two *different variants* of one unique ring plus a distinct ring. The
  // variants have different item strings, so anything keying on the string
  // would happily wear both — which is the failure mode this guards.
  f.add('finger', 10, { id: 900, meta: UNIQUE })
  f.add('finger', 20, { id: 900, meta: UNIQUE })
  f.add('finger', 30, { id: 901 })
  const result = await solveTopGear(f.profile, f.options)

  // Countable by hand: of the three unordered pairs, only the two involving the
  // distinct ring are legal, so the unique pair is the single exclusion.
  assert.equal(result.combinationCount, 2n)
  for (const combination of result.shortlist) {
    const ids = worn(combination.gear).filter((i) => i.slotClass === 'finger').map((i) => i.item.id)
    assert.equal(new Set(ids).size, ids.length, `unique ring worn twice: ${ids.join(',')}`)
  }
})

test('identical copies of one ring are interchangeable, not two choices', async () => {
  const f = fixture()
  // Same id AND the same emitted string: two physical copies of one ring. The
  // solver must treat them as one choice, or it inflates the search space with
  // combinations that differ in nothing.
  f.add('finger', 10, { id: 900, meta: UNIQUE })
  f.add('finger', 10, { id: 900, meta: UNIQUE })
  f.add('finger', 30, { id: 901 })
  const result = await solveTopGear(f.profile, f.options)
  assert.equal(result.combinationCount, 1n)
})

test('a category limit is never exceeded, however the shortlist was reached', async () => {
  const f = fixture()
  const limited = { categories: [{ key: 'gemcat', limit: 1 }] }
  // One limited and one free option per slot, so a legal set exists. With only
  // limited items the answer is correctly zero, which tests nothing.
  for (const [slot, score] of [['head', 10], ['chest', 11], ['hands', 12], ['feet', 13]] as const) {
    f.add(slot, score, limited)
    f.add(slot, score - 5)
  }
  const result = await solveTopGear(f.profile, f.options)
  assert.ok(result.shortlist.length > 0, 'no combinations produced')
  for (const combination of result.shortlist) {
    const used = worn(combination.gear).filter((i) => i.ilvl >= 10 && i.ilvl <= 13).length
    assert.ok(used <= 1, `${used} items of a quantity-1 category worn together`)
  }
})

test('the embellishment cap of two binds on every returned set', async () => {
  const f = fixture()
  // Again one embellished and one plain option per slot, or every set breaches
  // the cap and the legal answer is zero.
  for (const [slot, score] of [['head', 10], ['chest', 11], ['hands', 12], ['feet', 13]] as const) {
    f.add(slot, score, { embellishments: 1 })
    f.add(slot, score - 5)
  }
  const result = await solveTopGear(f.profile, f.options)
  assert.ok(result.shortlist.length > 0, 'no combinations produced')
  for (const combination of result.shortlist) {
    const embellished = worn(combination.gear).filter((i) => i.ilvl >= 10 && i.ilvl <= 13).length
    assert.ok(embellished <= 2, `${embellished} embellishments worn, cap is 2`)
  }
})

test('adding a constraint can only reduce the combination count', async () => {
  // A property that holds whatever the enumeration strategy is: restrictions
  // only ever subtract. If a constraint ever *raises* the count, the search is
  // counting something it should not be able to reach.
  const build = async (constrain: boolean): Promise<bigint> => {
    const f = fixture()
    const categories = constrain ? [{ key: 'shared', limit: 1 }] : []
    f.add('finger', 10, { categories })
    f.add('finger', 11, { categories })
    f.add('trinket', 12, { categories })
    f.add('trinket', 13, { categories })
    const result = await solveTopGear(f.profile, f.options)
    return result.combinationCount
  }
  const free = await build(false)
  const limited = await build(true)
  assert.ok(free > 0n, 'unconstrained case produced nothing')
  assert.ok(limited <= free, `constraining raised the count: ${free} -> ${limited}`)
  assert.ok(limited < free, 'the constraint excluded nothing, so it is not being applied')
})

test('an item with unknown restrictions is excluded, not assumed legal', async () => {
  const f = fixture()
  const known = f.add('head', 10)
  const unknown = f.add('head', 99)
  const result = await solveTopGear(f.profile, {
    ...f.options,
    // undefined means "no data", which must fail closed.
    restrictions: (c) => (c === unknown ? undefined : { categories: [], embellishments: 0 })
  })
  assert.ok(result.excluded.some((e) => e.item === unknown), 'the unknown item was not excluded')
  for (const combination of result.shortlist) {
    assert.ok(!worn(combination.gear).includes(unknown), 'an item with no restriction data was worn')
  }
  assert.ok(result.shortlist.some((c) => worn(c.gear).includes(known)), 'the known item was lost too')
})

// A category an item consumes twice — two gems of one quantity-1 category
// in a single neck — was counted as one unit, so an unequippable item competed
// and could win its slot. Both assertions fail when `uses` is ignored.

test('an item consuming two units of a quantity-1 category is never worn', async () => {
  const f = fixture()
  // At the solver: one neck carrying the same quantity-1
  // gem twice, scored above a legal neck so it wins on score alone.
  const illegal = f.add('neck', 99, { categories: [{ key: '698', limit: 1, uses: 2 }] })
  f.add('neck', 10, { categories: [{ key: '698', limit: 1, uses: 1 }] })
  const result = await solveTopGear(f.profile, f.options)
  assert.ok(result.shortlist.length > 0, 'the solver returned nothing at all')
  for (const combination of result.shortlist) {
    assert.ok(!worn(combination.gear).includes(illegal),
      'a neck wearing two copies of a quantity-1 gem was placed')
  }
})

test('a quantity-2 category admits two units in one item but not three', async () => {
  const two = async (uses: number): Promise<boolean> => {
    const f = fixture()
    const item = f.add('neck', 99, { categories: [{ key: '700', limit: 2, uses }] })
    f.add('neck', 10)
    const result = await solveTopGear(f.profile, f.options)
    return result.shortlist.some((c) => worn(c.gear).includes(item))
  }
  assert.equal(await two(2), true, 'two units of a quantity-2 category must fit one item')
  assert.equal(await two(3), false, 'three units of a quantity-2 category must not fit')
})

test('usage is per item, and still shared across items', async () => {
  const f = fixture()
  // Two rings each consuming one unit of a quantity-1 category: legal apart,
  // illegal together. This is the behaviour that already worked and must not
  // regress now that usage is counted rather than assumed.
  const a = f.add('finger', 30, { id: 910, categories: [{ key: '698', limit: 1, uses: 1 }] })
  const b = f.add('finger', 20, { id: 911, categories: [{ key: '698', limit: 1, uses: 1 }] })
  f.add('finger', 10, { id: 912 })
  const result = await solveTopGear(f.profile, f.options)
  for (const combination of result.shortlist) {
    const rings = worn(combination.gear).filter((i) => i.slotClass === 'finger')
    assert.ok(!(rings.includes(a) && rings.includes(b)), 'two items shared a quantity-1 category')
  }
})
