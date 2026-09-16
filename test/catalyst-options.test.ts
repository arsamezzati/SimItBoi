import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { catalystOptions, catalystTwin } from '../src/core/topgear/catalyst.ts'
import { parseHypotheticals } from '../src/core/topgear/hypothetical.ts'
import { catalogItem } from '../src/core/data/catalog.ts'
import { lookupItem } from '../src/core/data/itemTable.ts'

/**
 * Catalyst conversions offered to Top Gear.
 *
 * Season 2 conversions keep the original item's level and stat split, so one
 * tier slot has as many stat splits as the character has convertible pieces.
 * These pin the transformation: tier identity, original everything else.
 */

const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
const owned = [...profile.equipped, ...profile.bagItems]
const TIER_SLOTS = ['head', 'shoulder', 'chest', 'hands', 'legs']

test('a conversion keeps the original item, and only changes what the catalyst changes', () => {
  // Any piece of the character's own gear that this season's catalyst accepts.
  const source = owned.find((c) => c.slotClass === 'chest' && catalystTwin(profile, c))!
  assert.ok(source, 'no chest piece could be converted')
  const twin = catalystTwin(profile, source)!

  const tokens = Object.fromEntries(twin.itemString.split(',').slice(1).map((t) => t.split('=') as [string, string]))
  assert.equal(twin.itemString.split('=,')[0], source.item.emittedSlot)
  assert.equal(tokens['redirected_base_stats'], String(source.item.id), 'the original item is not named as the stat source')
  assert.notEqual(tokens['id'], String(source.item.id), 'the conversion kept the original item id')
  assert.ok(lookupItem(Number(tokens['id']))?.setId, 'the conversion did not produce a tier piece')

  // The original's own bonus ids survive: they carry its item level.
  const original = source.item.bonusIds.map(String)
  const converted = tokens['bonus_id']!.split('/')
  for (const bonus of original) assert.ok(converted.includes(bonus), 'bonus id ' + bonus + ' was dropped')
  assert.ok(catalogItem(Number(tokens['id']))!.bonusIds.every((b) => converted.includes(String(b))), 'the tier bonus ids are missing')
})

test('gems and the enchant come along; crafted and tier pieces are refused', () => {
  const enchanted = owned.find((c) => c.item.enchantId && catalystTwin(profile, c))
  if (enchanted) {
    assert.match(catalystTwin(profile, enchanted)!.itemString, new RegExp('enchant_id=' + enchanted.item.enchantId))
  }
  const crafted = owned.find((c) => c.item.tokens.some((t) => t.key === 'crafted_stats'))!
  assert.equal(catalystTwin(profile, crafted), null, 'a crafted piece was offered for conversion')
  const alreadyTier = owned.find((c) => lookupItem(c.item.id)?.setId)!
  assert.equal(catalystTwin(profile, alreadyTier), null, 'a tier piece was offered for conversion again')
  const ring = owned.find((c) => c.slotClass === 'finger')!
  assert.equal(catalystTwin(profile, ring), null, 'a ring was offered for conversion')
})

test('every offer is a candidate Top Gear accepts, in a tier slot, with no duplicates', () => {
  const options = catalystOptions(profile)
  assert.ok(options.length > 0)
  const { accepted, rejected } = parseHypotheticals(profile, options)
  assert.deepEqual(rejected, [], 'an offered conversion was refused as a candidate')
  assert.equal(accepted.length, options.length)
  assert.equal(new Set(options.map((o) => o.itemString)).size, options.length, 'the same conversion was offered twice')
  for (const candidate of accepted) {
    assert.ok(TIER_SLOTS.includes(candidate.candidate.slotClass), candidate.candidate.slotClass + ' is not a tier slot')
    assert.ok(lookupItem(candidate.candidate.item.id)?.setId)
  }
  // Several splits for one slot is the point of the feature.
  const chest = options.filter((o) => o.itemString.startsWith('chest='))
  assert.ok(chest.length >= 2, 'only one chest conversion was offered')
})
