import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import {
  parseHypothetical,
  parseHypotheticals,
  declarationsFrom,
  type HypotheticalCandidate,
  type HypotheticalError
} from '../src/core/topgear/hypothetical.ts'
import { embellishmentCount, equipmentRestrictions, restrictionsWith } from '../src/core/data/embellish.ts'
import { limitCategoryFor } from '../src/core/data/db2.ts'
import { solveTopGear } from '../src/core/topgear/solver.ts'
import { emitItemString } from '../src/core/parser/addonProfile.ts'

const profile = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

function ok(r: HypotheticalCandidate | HypotheticalError): HypotheticalCandidate {
  if ('reason' in r) throw new Error(`expected success, got: ${r.reason}`)
  return r
}

test('a valid item string becomes a hypothetical candidate', () => {
  const r = ok(parseHypothetical(profile(), {
    itemString: 'trinket1=,id=250214,bonus_id=13440/6652/12699/12846'
  }))
  assert.equal(r.candidate.item.id, 250214)
  assert.equal(r.candidate.slotClass, 'trinket')
  assert.equal(r.candidate.source, 'hypothetical')
  assert.deepEqual(r.candidate.item.bonusIds, [13440, 6652, 12699, 12846])
})

test('the item string round-trips, so simc receives exactly what was typed', () => {
  const input = 'trinket1=,id=250214,bonus_id=13440/6652,enchant_id=7967'
  const r = ok(parseHypothetical(profile(), { itemString: input }))
  assert.equal(emitItemString(r.candidate.item), input)
})

test('a leading # is tolerated, since exports are pasted with them', () => {
  const r = ok(parseHypothetical(profile(), { itemString: '# trinket1=,id=250214,bonus_id=6652' }))
  assert.equal(r.candidate.item.id, 250214)
})

test('garbage is rejected with an explanation, not silently dropped', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /empty/i],
    ['not an item at all', /simc item line/i],
    ['trinket1=,bonus_id=6652', /valid id/i],
    ['tabard=,id=246795', /not a simulated equipment slot/i],
    ['trinket1=,id=999999999', /not in the bundled item table/i]
  ]
  for (const [input, pattern] of cases) {
    const r = parseHypothetical(profile(), { itemString: input })
    assert.ok('reason' in r, `expected rejection for "${input}"`)
    assert.match(r.reason, pattern)
  }
})

test('declared items are validated like owned ones — wrong armour class is refused', () => {
  // 268224 Venom Warden's Greaves is plate; the fixture character wears mail.
  const r = parseHypothetical(profile(), { itemString: 'legs=,id=268224,bonus_id=6652' })
  assert.ok('reason' in r)
  assert.match(r.reason, /cannot wear/i)
})

test('a weapon in a non-weapon slot is refused', () => {
  const r = parseHypothetical(profile(), { itemString: 'head=,id=245770,bonus_id=6652' })
  assert.ok('reason' in r)
  assert.match(r.reason, /non-weapon slot/i)
})

test('an advanced item with no declared level does not invent a display level', () => {
  const p = profile()
  const r = ok(parseHypothetical(p, { itemString: 'trinket1=,id=250214,bonus_id=6652' }))
  assert.equal(r.candidate.ilvl, 0)
})

test('the marker decides, and a declaration still covers items without one', () => {
  const p = profile()
  // A crafted epic carrying no Embellished marker is not embellished.
  const plain = ok(parseHypothetical(p, {
    itemString: 'legs=,id=244582,bonus_id=12214/13667,crafting_quality=5',
    embellished: false
  }))
  assert.equal(embellishmentCount(plain.candidate), 0, 'no marker, no embellishment')
  const declared = declarationsFrom([plain])
  assert.equal(embellishmentCount(plain.candidate, declared), 0, 'the declaration agrees')

  // The real fixture legs DO carry the marker (8960), measured not declared.
  const marked = ok(parseHypothetical(p, {
    itemString: 'legs=,id=244582,bonus_id=12214/13667/8960,crafting_quality=5',
    embellished: false
  }))
  assert.equal(embellishmentCount(marked.candidate, declarationsFrom([marked])), 1, 'the marker overrides explicit false')

  // And an embellished item that the proxy would miss (not crafted).
  const nonCrafted = ok(parseHypothetical(p, {
    itemString: 'trinket1=,id=250214,bonus_id=6652',
    embellished: true
  }))
  assert.equal(embellishmentCount(nonCrafted.candidate), 0)
  assert.equal(embellishmentCount(nonCrafted.candidate, declarationsFrom([nonCrafted])), 1)
})

test('unknown embellishment eligibility remains undeclared', () => {
  const unknown = ok(parseHypothetical(profile(), { itemString: 'trinket1=,id=250214,bonus_id=6652' }))
  assert.equal(unknown.embellished, undefined)
  assert.equal(declarationsFrom([unknown]).has(unknown.candidate), false)
})

test('parseHypotheticals separates accepted from rejected', () => {
  const r = parseHypotheticals(profile(), [
    { itemString: 'trinket1=,id=250214,bonus_id=6652' },
    { itemString: 'nonsense' },
    { itemString: 'finger1=,id=268252,bonus_id=6652' }
  ])
  assert.equal(r.accepted.length, 2)
  assert.equal(r.rejected.length, 1)
})

test('the solver accepts a declared item but still refuses undeclared foreign ones', async () => {
  const p = profile()
  const h = ok(parseHypothetical(p, { itemString: 'trinket1=,id=251785,bonus_id=6652/12843' }))

  // Declared: allowed.
  const fine = await solveTopGear(p, {
    shortlistSize: 3, scoreItem: () => 0,
    selected: [...p.bagItems, h.candidate],
    hypothetical: [h.candidate],
    restrictions: restrictionsWith(declarationsFrom([h])), restrictionsAreApproximate: true
  })
  assert.ok(BigInt(fine.combinationCount) > 0n)

  // Same item, NOT declared: the guard must still bite.
  await assert.rejects(
    async () => solveTopGear(p, {
      shortlistSize: 3, scoreItem: () => 0,
      selected: [...p.bagItems, h.candidate],
      restrictions: restrictionsWith(), restrictionsAreApproximate: true
    }),
    /must be owned entries.*or declared hypothetical/i
  )
})

test('three declared embellishments still cannot be worn together', async () => {
  const p = profile()
  // Three hypothetical items in distinct slots, all declared embellished.
  const items = [
    'head=,id=271483,bonus_id=6652',
    'wrist=,id=251200,bonus_id=6652',
    'waist=,id=268254,bonus_id=6652'
  ].map((itemString) => ok(parseHypothetical(p, { itemString, embellished: true })))

  const declared = declarationsFrom(items)
  for (const i of items) assert.equal(embellishmentCount(i.candidate, declared), 1)

  const r = await solveTopGear(p, {
    shortlistSize: 3, scoreItem: () => 0,
    selected: [...p.bagItems, ...items.map((i) => i.candidate)],
    hypothetical: items.map((i) => i.candidate),
    restrictions: restrictionsWith(declared), restrictionsAreApproximate: true
  })
  const over = r.shortlist.some((set) => {
    const gear = Object.values(set.gear ?? {}).flat() as Array<{ item?: unknown }>
    return gear.filter((g) => g && embellishmentCount(g as never, declared) > 0).length > 2
  })
  assert.equal(over, false, 'the cap must bind for declared items too')
})

// The guided resolvers rejected a duplicated unique gem, but a typed item
// string skipped that check entirely and the solver then counted the pair as
// one unit of the category.

/** A quantity-1 gem, and a neck with a socket for it. */
const UNIQUE_GEM = 240966
const NECK = 268251

test('an exact import cannot wear the same quantity-1 gem twice', () => {
  const category = limitCategoryFor(UNIQUE_GEM)
  assert.ok(category, 'the test gem left the limit-category table')
  assert.equal(category.quantity, 1)

  const refused = parseHypothetical(profile(), { itemString: `neck=,id=${NECK},gem_id=${UNIQUE_GEM}/${UNIQUE_GEM}` })
  assert.ok('reason' in refused, 'a duplicated quantity-1 gem was accepted from a typed item string')
  assert.match(refused.reason, new RegExp(`Only 1 ${category.name}`))

  // One copy is still perfectly legal.
  const accepted = ok(parseHypothetical(profile(), { itemString: `neck=,id=${NECK},gem_id=${UNIQUE_GEM}` }))
  assert.deepEqual(accepted.candidate.item.gemIds, [UNIQUE_GEM])
})

test('an item reports how many units of a category it consumes', () => {
  const single = ok(parseHypothetical(profile(), { itemString: `neck=,id=${NECK},gem_id=${UNIQUE_GEM}` }))
  const category = String(limitCategoryFor(UNIQUE_GEM)!.id)
  const entry = equipmentRestrictions(single.candidate).categories.find((c) => c.key === category)
  assert.ok(entry, 'the gem category vanished from the restrictions')
  assert.equal(entry.limit, 1)
  assert.equal(entry.uses, 1)

  // The same item with the gem duplicated must report two uses, not one. It
  // cannot be parsed any more, so build the candidate directly: the solver has
  // to be safe for any candidate that reaches it, not only parsed ones.
  const doubled = {
    ...single.candidate,
    item: { ...single.candidate.item, gemIds: [UNIQUE_GEM, UNIQUE_GEM] }
  }
  const doubledEntry = equipmentRestrictions(doubled).categories.find((c) => c.key === category)
  assert.ok(doubledEntry)
  assert.equal(doubledEntry.limit, 1)
  assert.equal(doubledEntry.uses, 2, 'two gems of one category were collapsed into a single unit')
})
