import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CandidateItem, SlotClass } from '../src/core/types.ts'
import type { ItemMeta } from '../src/core/data/itemTable.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { solveTopGear, combinationOverrides, type SolverOptions } from '../src/core/topgear/solver.ts'
import type { SpecRules } from '../src/core/topgear/weapons.ts'

function fixture() {
  const profile = parseAddonProfile('shaman="Test"\nspec=elemental\n')
  const metadata = new Map<number, ItemMeta>()
  let id = 0
  const slots: Record<string, string> = { head: 'HEAD', shoulder: 'SHOULDER', chest: 'CHEST', hands: 'HAND',
    legs: 'LEGS', neck: 'NECK', back: 'CLOAK', wrist: 'WRIST', waist: 'WAIST', feet: 'FEET', finger: 'FINGER', trinket: 'TRINKET' }
  function add(slot: SlotClass, score: number, meta: Partial<ItemMeta> = {}, equipped = false): CandidateItem {
    const itemId = ++id
    const item: CandidateItem = { name: `item${itemId}`, ilvl: score, slotClass: slot,
      source: equipped ? 'equipped' : 'bags', item: { emittedSlot: slot, id: itemId, bonusIds: [], gemIds: [],
        tokens: [{ key: 'id', value: String(itemId) }] } }
    metadata.set(itemId, { inventoryType: slots[slot] ?? 'TWOHWEAPON', itemClassId: 4, itemSubclassId: 0,
      armorClass: 'misc', unique: { kind: 'none' }, ...meta })
    ;(equipped ? profile.equipped : profile.bagItems).push(item)
    return item
  }
  const staff = add('main_hand', 0, { weaponType: 'two_hand', itemClassId: 2 }, true)
  const options: SolverOptions = { shortlistSize: 10, ilvlFloor: 0, scoreItem: (c) => c.ilvl,
    lookup: (id) => metadata.get(id), rules: { configs: ['two_hand', 'one_hand_offhand'], offHand: ['shield'], verified: true },
    eligibility: () => true, restrictions: () => ({ categories: [], embellishments: 0 }) }
  return { profile, metadata, add, staff, options }
}

test('top-K and exact count match exhaustive Cartesian enumeration', async () => {
  const f = fixture()
  const scores = [[1, 4, 7], [2, 6], [3, 8, 12]]
  for (const [i, slot] of (['head', 'chest', 'feet'] as const).entries()) for (const score of scores[i]) f.add(slot, score)
  const expected = scores[0].flatMap((a) => scores[1].flatMap((b) => scores[2].map((c) => a + b + c))).sort((a, b) => b - a)
  const result = await solveTopGear(f.profile, { ...f.options, shortlistSize: 5 })
  assert.equal(result.combinationCount, BigInt(expected.length))
  assert.deepEqual(result.shortlist.map((c) => c.score), expected.slice(0, 5))
  assert.equal(new Set(result.shortlist.map((c) => c.key)).size, 5)
  assert.equal(result.validation, 'verified')
})

test('low-scoring 4pc survives and counts 0/2/4 buckets correctly', async () => {
  const f = fixture()
  for (const slot of ['head', 'shoulder', 'chest', 'hands'] as const) {
    f.add(slot, 0, { setId: 100 })
    f.add(slot, 100)
  }
  const result = await solveTopGear(f.profile, { ...f.options, shortlistSize: 3 })
  assert.equal(result.combinationCount, 16n)
  assert.deepEqual(result.buckets.map((b) => [b.tier['100'], b.count]).sort((a, b) => Number(a[0]) - Number(b[0])), [[0, 5n], [2, 10n], [4, 1n]])
  assert.deepEqual(result.shortlist.map((c) => c.tier['100']).sort(), [0, 2, 4])
  await assert.rejects(solveTopGear(f.profile, { ...f.options, shortlistSize: 2 }), /at least 3/)
})

test('pieces from different sets do not become a fabricated four-piece bonus', async () => {
  const f = fixture()
  f.add('head', 1, { setId: 100 }); f.add('shoulder', 1, { setId: 100 })
  f.add('chest', 1, { setId: 200 }); f.add('hands', 1, { setId: 200 })
  const result = await solveTopGear(f.profile, f.options)
  assert.deepEqual(result.shortlist[0].tier, { 100: 2, 200: 2 })
})

test('ring pairs preserve variants, ownership, and unique limits without permutations', async () => {
  const f = fixture()
  const ring = f.add('finger', 10)
  const copy = structuredClone(ring)
  f.profile.bagItems.push(copy)
  const variant = structuredClone(ring)
  variant.item.tokens.push({ key: 'bonus_id', value: '12345' })
  variant.ilvl = 12
  f.profile.bagItems.push(variant)
  f.add('finger', 8)
  let result = await solveTopGear(f.profile, f.options)
  assert.equal(result.combinationCount, 4n) // AA, AB, AC, BC; two physical A copies
  assert.equal(result.shortlist[0].score, 22)
  f.metadata.get(ring.item.id)!.unique = { kind: 'item', limit: 1, raw: 'Unique-Equipped' }
  result = await solveTopGear(f.profile, f.options)
  assert.equal(result.combinationCount, 2n) // AC, BC
  assert.ok(result.shortlist.some((c) => combinationOverrides(c).some((line) => line.includes('bonus_id=12345'))))
})

test('cross-slot category limits and embellishments are enforced across the whole set', async () => {
  const f = fixture()
  const restricted = new Set<number>()
  for (const slot of ['head', 'chest', 'feet'] as const) {
    restricted.add(f.add(slot, 10).item.id)
    f.add(slot, 1)
  }
  const result = await solveTopGear(f.profile, { ...f.options, restrictions: (c) => ({
    categories: restricted.has(c.item.id) ? [{ key: 'shared', limit: 1 }] : [], embellishments: 0
  }) })
  assert.equal(result.combinationCount, 4n)
  assert.equal(result.shortlist[0].score, 12)
  const embellished = await solveTopGear(f.profile, { ...f.options, restrictions: (c) => ({
    categories: [], embellishments: restricted.has(c.item.id) ? 1 : 0
  }) })
  assert.equal(embellished.combinationCount, 7n)
  assert.equal(embellished.shortlist[0].score, 21)
})

test('weapon branches include paired swaps and explicitly empty the off-hand', async () => {
  const f = fixture()
  f.add('main_hand', 10, { weaponType: 'one_hand' })
  f.add('off_hand', 5, { weaponType: 'shield' })
  const result = await solveTopGear(f.profile, f.options)
  assert.equal(result.combinationCount, 2n)
  assert.ok(result.shortlist.some((c) => c.gear.off_hand?.item.id))
  const twoHand = result.shortlist.find((c) => c.gear.main_hand === f.staff)!
  assert.ok(combinationOverrides(twoHand).includes('off_hand=none'))
  assert.equal(twoHand.gear.off_hand, null)
})

test('Titan’s Grip uses two copies, respects talent gating, and preserves weapon ordering', async () => {
  const f = fixture()
  const other = f.add('off_hand', 2, { weaponType: 'two_hand' }, true)
  f.add('main_hand', 100, { weaponType: 'one_hand' })
  f.add('off_hand', 100, { weaponType: 'one_hand' })
  const rules: SpecRules = { configs: ['titans_grip', 'dual_wield_1h'], talentGated: ['titans_grip', 'dual_wield_1h'], verified: true }
  const result = await solveTopGear(f.profile, { ...f.options, rules })
  assert.equal(result.combinationCount, 2n)
  for (const c of result.shortlist) assert.deepEqual(new Set(Object.values(c.gear).filter(Boolean)), new Set([f.staff, other]))
})

test('unknown metadata is excluded, equipped gear survives the floor, and selection is owned-only', async () => {
  const f = fixture()
  const low = f.add('head', 1, {}, true)
  const unknown = f.add('head', 200)
  f.metadata.delete(unknown.item.id)
  const result = await solveTopGear(f.profile, { ...f.options, ilvlFloor: 100 })
  assert.equal(result.shortlist[0].gear.head, low)
  assert.ok(result.excluded.some((c) => c.item === unknown))
  await assert.rejects(solveTopGear(f.profile, { ...f.options, selected: [structuredClone(low)] }), /owned/)
})

test('coverage gaps cannot masquerade as verified legality', async () => {
  const f = fixture()
  const result = await solveTopGear(f.profile, { ...f.options, restrictions: undefined })
  assert.equal(result.validation, 'provisional')
  assert.ok(result.warnings.length)
  await assert.rejects(solveTopGear(f.profile, { ...f.options, restrictions: undefined, requireVerified: true }), /unverified/)
  await assert.rejects(solveTopGear(f.profile, { ...f.options, eligibility: undefined, requireVerified: true }), /subclass/)
})

test('supplied eligibility rules apply to each actual weapon placement', async () => {
  const f = fixture()
  const dagger = f.add('main_hand', 10, { weaponType: 'one_hand' })
  const sword = f.add('main_hand', 100, { weaponType: 'one_hand' })
  const result = await solveTopGear(f.profile, { ...f.options,
    rules: { configs: ['dual_wield_1h'], verified: true },
    eligibility: (c, slot) => slot !== 'main_hand' || c === dagger
  })
  assert.equal(result.combinationCount, 1n)
  assert.equal(result.shortlist[0].gear.main_hand, dagger)
  assert.equal(result.shortlist[0].gear.off_hand, sword)
})

test('cloth cloaks remain wearable by mail classes; cloth chest pieces do not', async () => {
  const f = fixture()
  const cloak = f.add('back', 10, { armorClass: 'cloth' }, true)
  const cloth = f.add('chest', 100, { armorClass: 'cloth' })
  const mail = f.add('chest', 1, { armorClass: 'mail' })
  const result = await solveTopGear(f.profile, f.options)
  assert.equal(result.shortlist[0].gear.back, cloak)
  assert.equal(result.shortlist[0].gear.chest, mail)
  assert.ok(result.excluded.some((e) => e.item === cloth))
})

test('cancellation and memory guards fail explicitly, never return a partial exact count', async () => {
  const f = fixture()
  for (const slot of ['head', 'chest', 'feet'] as const) { f.add(slot, 1, { setId: 1 }); f.add(slot, 2) }
  await assert.rejects(solveTopGear(f.profile, { ...f.options, maxStates: 1 }), /maxStates/)
  await assert.rejects(solveTopGear(f.profile, { ...f.options, maxRetainedPaths: 1 }), /maxRetainedPaths/)
  await assert.rejects(solveTopGear(f.profile, { ...f.options, maxGroupChoices: 1 }), /maxGroupChoices/)
  const abort = new AbortController()
  await assert.rejects(solveTopGear(f.profile, { ...f.options, signal: abort.signal, onProgress: () => abort.abort() }), /abort/i)
  await assert.rejects(solveTopGear(f.profile, { ...f.options, scoreItem: () => NaN }), /finite/)
})

test('counts remain exact above Number.MAX_SAFE_INTEGER without enumerating every set', async () => {
  const f = fixture()
  for (const slot of ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger', 'trinket'] as const) {
    for (let i = 0; i < 30; i++) f.add(slot, i)
  }
  const result = await solveTopGear(f.profile, { ...f.options, shortlistSize: 1 })
  const expected = 30n ** 10n * 435n ** 2n
  assert.ok(expected > BigInt(Number.MAX_SAFE_INTEGER))
  assert.equal(result.combinationCount, expected)
  assert.equal(result.shortlist[0].score, 10 * 29 + 2 * (29 + 28))
  assert.equal(result.peakStates, 1)
})

test('state pruning agrees with a brute-force oracle for mixed tiers and constraints', async () => {
  const f = fixture()
  const groups: CandidateItem[][] = []
  const marked = new Set<number>()
  for (const slot of ['head', 'chest', 'hands', 'feet'] as const) {
    const choices = [f.add(slot, 3), f.add(slot, 7, { setId: 10 }), f.add(slot, 11, { setId: 20 })]
    marked.add(choices[2].item.id)
    groups.push(choices)
  }
  const expected = new Map<string, number[]>()
  for (const a of groups[0]) for (const b of groups[1]) for (const c of groups[2]) for (const d of groups[3]) {
    const set = [a, b, c, d]
    if (set.filter((i) => marked.has(i.item.id)).length > 2) continue
    const tier = [10, 20].map((id) => {
      const n = set.filter((i) => f.metadata.get(i.item.id)?.setId === id).length
      return n >= 4 ? 4 : n >= 2 ? 2 : 0
    }).join(',')
    const scores = expected.get(tier) ?? []
    scores.push(set.reduce((sum, i) => sum + i.ilvl, 0))
    expected.set(tier, scores)
  }
  const result = await solveTopGear(f.profile, { ...f.options, shortlistSize: 9,
    restrictions: (c) => ({ categories: [], embellishments: marked.has(c.item.id) ? 1 : 0 }) })
  assert.equal(result.combinationCount, BigInt([...expected.values()].reduce((sum, values) => sum + values.length, 0)))
  const protectedScores: number[] = [], rest: number[] = []
  for (const bucket of result.buckets) {
    const key = `${bucket.tier['10']},${bucket.tier['20']}`
    const scores = expected.get(key)!.sort((a, b) => b - a)
    assert.equal(bucket.count, BigInt(scores.length))
    protectedScores.push(scores[0]); rest.push(...scores.slice(1))
  }
  const best = [...protectedScores, ...rest.sort((a, b) => b - a).slice(0, 9 - protectedScores.length)].sort((a, b) => b - a)
  assert.deepEqual(result.shortlist.map((c) => c.score), best)
})
