import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catalog, resolveCatalog } from '../src/core/data/catalog.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { parseHypothetical } from '../src/core/topgear/hypothetical.ts'
import { embellishmentCount } from '../src/core/data/embellish.ts'
import { embellishments } from '../src/core/data/db2.ts'

const profile = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

function trackedDrop(): { itemId: number; track: string; ilvl: number } {
  const item = catalog().items.find((i) => i.id === 250214)!
  const variant = item.variants.find((v) => v.track === 'Hero' && v.ilvl === 321)!
  return { itemId: item.id, track: variant.track, ilvl: variant.ilvl }
}

test('a normal guided track selection emits no crafted tokens', () => {
  const result = resolveCatalog(trackedDrop(), 'shaman')
  assert.ok(!result.itemString.includes('crafted_stats'))
  assert.ok(!result.itemString.includes('crafting_quality'))
})

test('guided track drops cannot be turned into crafted items', () => {
  const base = trackedDrop()
  for (const extra of [
    { craftedStats: [40, 32] },
    { craftingQuality: 5 },
    { craftedStats: [49], craftingQuality: 4 }
  ]) {
    assert.throws(() => resolveCatalog({ ...base, ...extra }, 'shaman'), /belong to the Crafted picker/i)
  }
})

test('guided track drops refuse known and unknown embellishments', () => {
  const base = trackedDrop()
  assert.throws(
    () => resolveCatalog({ ...base, embellishmentBonusId: embellishments()[0]!.bonusId }, 'shaman'),
    /embellishments belong to the Crafted picker/i
  )
  assert.throws(() => resolveCatalog({ ...base, embellishmentBonusId: 999_999 }, 'shaman'), /unknown embellishment/i)
})

test('advanced exact imports preserve crafted tokens', () => {
  const itemString = 'legs=,id=244582,bonus_id=12214/13667,crafted_stats=40/32,crafting_quality=5'
  const parsed = parseHypothetical(profile(), { itemString })
  assert.ok(!('reason' in parsed), `rejected: ${'reason' in parsed ? parsed.reason : ''}`)
  assert.equal(parsed.candidate.item.tokens.some((t) => t.key === 'crafted_stats' && t.value === '40/32'), true)
})

test('legacy guided crafting choices are rejected for explicit review', () => {
  const parsed = parseHypothetical(profile(), {
    itemString: 'trinket1=,id=250214',
    selection: { ...trackedDrop(), craftingQuality: 5 }
  })
  assert.ok('reason' in parsed)
  assert.match(parsed.reason, /belong to the Crafted picker/i)
})

test('a marker-bearing advanced item counts despite an explicit false declaration', () => {
  const parsed = parseHypothetical(profile(), {
    itemString: 'legs=,id=244582,bonus_id=12214/13667/8960,crafting_quality=5',
    embellished: false
  })
  assert.ok(!('reason' in parsed))
  assert.equal(embellishmentCount(parsed.candidate, new Map([[parsed.candidate, false]])), 1)
})
