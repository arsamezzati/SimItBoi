import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catalog, catalogIdentity, resolveCatalog, searchCatalog } from '../src/core/data/catalog.ts'
import { parseAddonProfile, emitItemString } from '../src/core/parser/addonProfile.ts'
import { parseHypothetical } from '../src/core/topgear/hypothetical.ts'
const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
test('search supports names, numeric IDs, slots, class restrictions and empty results', () => {
  assert.equal(searchCatalog('lightspire core', 'shaman', 'trinket').items[0].id, 250214)
  assert.equal(searchCatalog('250214', 'shaman').items[0].name, 'Lightspire Core')
  assert.equal(searchCatalog('250214', 'shaman', 'head').total, 0)
  assert.equal(searchCatalog('271483', 'mage').total, 0)
  assert.equal(searchCatalog('thisdoesnotexistzzzz', 'shaman').total, 0)
  assert.ok(searchCatalog('', 'shaman').items.length <= 60)
})
test('track variants are distinct exact bonus strings, not level overrides', () => {
  const hero = resolveCatalog({ itemId: 250214, track: 'Hero', ilvl: 321 }, 'shaman')
  const myth = resolveCatalog({ itemId: 250214, track: 'Myth', ilvl: 321 }, 'shaman')
  assert.notEqual(hero.itemString, myth.itemString)
  assert.ok(!hero.itemString.includes('ilevel='))
  assert.equal(hero.ilvl, 321)
  assert.match(hero.label, /Lightspire Core/)
  const tier = resolveCatalog({ itemId: 271483, track: 'Myth', ilvl: 334 }, 'shaman')
  assert.match(tier.itemString, /13692\/13698/)
})
test('main-process resolution rejects fabricated or stale combinations', () => {
  for (const selection of [
    { itemId: 250214, track: 'Hero', ilvl: 334 },
    { itemId: 250214, track: 'Banana', ilvl: 321 },
    { itemId: 999999999, track: 'Myth', ilvl: 334 },
    { itemId: 250214, track: 'Hero', ilvl: 321, catalogGenerated: 'old' }
  ]) assert.throws(() => resolveCatalog(selection, 'shaman'))
  assert.throws(() => resolveCatalog({ itemId: 271483, track: 'Myth', ilvl: 334 }, 'mage'))
})
test('main-process resolution enforces enchant slot eligibility', () => {
  const ring = searchCatalog('', 'shaman', 'finger').items.find((i) => i.variants.length > 0)!
  const ringVariant = ring.variants[0]!
  const ringBase = { itemId: ring.id, track: ringVariant.track, ilvl: ringVariant.ilvl }
  assert.match(resolveCatalog({ ...ringBase, enchantId: 7964 }, 'shaman').itemString, /enchant_id=7964/)
  assert.throws(
    () => resolveCatalog({ itemId: 250214, track: 'Hero', ilvl: 321, enchantId: 7964 }, 'shaman'),
    /cannot be applied.*slot/i
  )
  assert.throws(() => resolveCatalog({ ...ringBase, enchantId: 5960 }, 'shaman'), /unknown slot eligibility/i)
  assert.throws(() => resolveCatalog({ ...ringBase, enchantId: 999_999 }, 'shaman'), /unknown enchant/i)
})
test('renderer tokens and labels cannot override a structured selection', () => {
  const before = profile.equipped.map((c) => emitItemString(c.item))
  const result = parseHypothetical(profile, {
    itemString: 'head=,id=123,ilevel=999', label: 'Forged label',
    selection: { itemId: 250214, track: 'Myth', ilvl: 334, catalogGenerated: catalogIdentity() }
  })
  assert.ok(!('reason' in result))
  assert.equal(result.candidate.item.id, 250214)
  assert.equal(result.candidate.ilvl, 334)
  assert.match(result.candidate.name, /Lightspire Core/)
  assert.equal(result.candidate.source, 'hypothetical')
  assert.deepEqual(profile.equipped.map((c) => emitItemString(c.item)), before)
})
test('advanced import refuses misplaced armor and invalid explicit levels', () => {
  assert.ok('reason' in parseHypothetical(profile, { itemString: 'head=,id=250214' }))
  assert.ok('reason' in parseHypothetical(profile, { itemString: 'trinket1=,id=250214,ilevel=NaN' }))
  assert.ok('reason' in parseHypothetical(profile, { itemString: 'trinket1=,id=250214,ilevel=-1' }))
})

test('catalog identity is content-based, not a timestamp', () => {
  const identity = catalogIdentity()
  assert.match(identity, /^sha256:[0-9a-f]{12}$/)
  // Stable across calls, and it is what search hands the renderer to store.
  assert.equal(identity, catalogIdentity())
  assert.equal(searchCatalog('', 'shaman').generated, identity)
  // The generation timestamp must no longer be what staleness keys on: an
  // identical rebuild changes it while the content identity stays put.
  assert.notEqual(identity, catalog().generated)
})

test('a selection carrying a stale catalog identity is refused for review', () => {
  // Via search, so the item is one this character can actually wear.
  const item = searchCatalog('', 'shaman').items.find((i) => i.variants.length)!
  const variant = item.variants[0]!
  const selection = { itemId: item.id, track: variant.track, ilvl: variant.ilvl }
  assert.doesNotThrow(() => resolveCatalog({ ...selection, catalogGenerated: catalogIdentity() }, 'shaman'))
  assert.throws(
    () => resolveCatalog({ ...selection, catalogGenerated: 'sha256:000000000000' }, 'shaman'),
    /older item catalog/
  )
})
