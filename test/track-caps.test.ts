import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  MYTHIC_FINAL_BOSS, TRACK_CAP, TRACK_ORDER, catalog, isPvpSource, resolveCatalog, searchCatalog, trackReachable
} from '../src/core/data/catalog.ts'

/**
 * Source-specific upgrade tracks.
 *
 * Every source used to be offered every track, so a delve cloak could be
 * configured at Myth 6/6 and simulated into a recommendation for gear that does
 * not exist. Caps come from method.gg's Season 2 Great Vault guide and agree
 * with the upgrade ladder shipped from Raidbots — see TRACK_CAP.
 */

const require_ = createRequire(import.meta.url)
interface SeasonItem {
  id: number; name: string; slot: string
  source?: { instanceType?: string; encounterId?: number; encounterName?: string }
  upgradeTracks: Array<{ track: string; itemLevel: number }>
}
const season2 = (require_('../src/core/data/season2-gear.json') as { items: SeasonItem[] }).items

const CLASS = 'shaman'

/** An item of this source the fixture class can wear, and its top rank on a track. */
function sample(sourceType: string, track: string): { item: SeasonItem; ilvl: number } {
  for (const item of season2) {
    if (item.source?.instanceType !== sourceType) continue
    const top = item.upgradeTracks.filter((t) => t.track === track).at(-1)
    if (!top) continue
    try {
      // Probe wearability with the lowest reachable variant, so the question
      // being asked below is only ever about the track.
      const low = item.upgradeTracks.find((t) => trackReachable(sourceType, t.track))
      if (!low) continue
      resolveCatalog({ itemId: item.id, track: low.track, ilvl: low.itemLevel }, CLASS)
      return { item, ilvl: top.itemLevel }
    } catch { /* not wearable by the fixture class; keep looking */ }
  }
  throw new Error('no wearable ' + sourceType + ' item carries ' + track)
}

test('world sources stop at Hero 6/6 and are refused at Myth', () => {
  for (const source of ['delve-mid2', 'prey-mid2']) {
    const hero = sample(source, 'Hero')
    assert.equal(hero.ilvl, 321, source + ' Hero 6/6 is not 321')
    assert.doesNotThrow(() => resolveCatalog({ itemId: hero.item.id, track: 'Hero', ilvl: 321 }, CLASS))

    const myth = sample(source, 'Myth')
    assert.throws(
      () => resolveCatalog({ itemId: myth.item.id, track: 'Myth', ilvl: myth.ilvl }, CLASS),
      /combination is unavailable/,
      source + ' was accepted at Myth ' + myth.ilvl
    )
  }
})

test('raid and Mythic+ reach Myth 6/6', () => {
  // Mythic+ reaching Myth is not a mistake to tighten later: the Great Vault
  // awards Myth 1/6 from +10 keys, and items upgrade within their track.
  for (const source of ['raid', 'dungeon']) {
    const myth = sample(source, 'Myth')
    assert.equal(myth.ilvl, 334)
    assert.doesNotThrow(() => resolveCatalog({ itemId: myth.item.id, track: 'Myth', ilvl: 334 }, CLASS))
  }
})

test('everything below a cap stays reachable', () => {
  for (const [source, cap] of Object.entries(TRACK_CAP)) {
    for (const track of TRACK_ORDER) {
      const allowed = TRACK_ORDER.indexOf(track) <= TRACK_ORDER.indexOf(cap)
      assert.equal(trackReachable(source, track), allowed, source + ' ' + track)
    }
  }
})

test('an unknown source reaches nothing rather than everything', () => {
  assert.equal(trackReachable(undefined, 'Adventurer'), false)
  assert.equal(trackReachable('some-future-source', 'Champion'), false)
  assert.equal(trackReachable('raid', 'Legendary'), false)
})

test('every source that carries tracks has a stated cap', () => {
  // A rebuild that introduces a new source type must fail here, not quietly
  // hide that source's items behind "reaches nothing".
  const uncapped = new Set(
    season2.filter((i) => i.upgradeTracks.length > 0)
      .map((i) => i.source?.instanceType ?? '(none)')
      .filter((type) => !TRACK_CAP[type])
  )
  assert.deepEqual([...uncapped], [], 'sources with tracks but no cap: ' + [...uncapped].join(', '))
})

test('no configurable variant exceeds its source cap', () => {
  for (const item of catalog().items) {
    for (const variant of item.variants) {
      assert.ok(trackReachable(item.sourceType, variant.track),
        item.name + ' offers ' + variant.track + ' from ' + item.sourceType)
    }
  }
})

test('PvP gear is kept out of guided search but still exists', () => {
  const pvp = season2.filter((i) => isPvpSource(i.source?.instanceType))
  assert.ok(pvp.length > 400, 'expected the Season 2 PvP set to be present')

  const results = searchCatalog('Gladiator', CLASS).items
  assert.deepEqual(results.filter((r) => isPvpSource(r.sourceType)), [],
    'PvP items reached guided search')
  // Nothing configurable was lost with them: PvP never carried a track.
  assert.ok(pvp.every((i) => i.upgradeTracks.length === 0))
})

// Above the cap: the last two Season 2 raid bosses drop at 344 on Mythic, which
// the catalog could not configure at all before, simulating the best gear in
// the season ten item levels short.

test('Mythic final-boss items offer 344, and only those do', () => {
  const offering = catalog().items.filter((i) => i.variants.some((v) => v.ilvl === MYTHIC_FINAL_BOSS.ilvl))
  assert.ok(offering.length > 20, 'expected the two final encounters to offer 344')
  for (const item of offering) {
    assert.match(item.source ?? '', /The Coiled Altar|Ula'tek/, item.name + ' offers 344 from ' + item.source)
  }

  // An early boss of the same raid cannot reach it.
  const early = season2.find((i) => i.source?.instanceType === 'raid' && i.name === 'Amani Summoning Shawl')
  assert.ok(early, 'the first-boss sample left the catalog')
  assert.throws(
    () => resolveCatalog({ itemId: early.id, track: 'Myth', ilvl: 344 }, CLASS),
    /combination is unavailable/
  )
})

test('a final-boss item resolves to the 344 bonus with a readable label', () => {
  const neck = catalog().items.find((i) => i.name === 'Aqirbane Reliquary')
  assert.ok(neck)
  const resolved = resolveCatalog({ itemId: neck.id, track: 'Myth', ilvl: 344 }, CLASS)
  assert.equal(resolved.ilvl, 344)
  assert.ok(resolved.itemString.split('bonus_id=')[1]!.split('/').includes(String(MYTHIC_FINAL_BOSS.bonusId)))
  assert.match(resolved.label, /Mythic final boss/)
  assert.doesNotMatch(resolved.label, /Myth Mythic/, 'the label repeats the track name')
  // Its ordinary rungs are still there alongside it.
  assert.doesNotThrow(() => resolveCatalog({ itemId: neck.id, track: 'Myth', ilvl: 334 }, CLASS))
})

test('the final encounters in the data are still the ones the rule names', () => {
  // Encounter ids are season data. If a rebuild renames or renumbers them, the
  // rule would silently stop applying — fail here instead.
  const names = new Map(season2.filter((i) => i.source?.instanceType === 'raid')
    .map((i) => [(i.source as { encounterId?: number }).encounterId, (i.source as { encounterName?: string }).encounterName]))
  assert.equal(names.get(2883), 'The Coiled Altar')
  assert.equal(names.get(2895), "Ula'tek")
})
