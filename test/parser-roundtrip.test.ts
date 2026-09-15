import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile, emitItemString } from '../src/core/parser/addonProfile.ts'

/**
 * Parser invariants. These were previously only printed by
 * test/parse-fixture.ts, so a regression would have shown up as different
 * console output that nothing read. Byte-identical round-tripping is a
 * hard requirement: the app re-emits item lines into simc input, and a token it
 * silently drops is a different item than the player has.
 */

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const profile = parseAddonProfile(raw)

/** tabard and shirt are cosmetic and deliberately not parsed as candidates. */
const COSMETIC = new Set(['tabard', 'shirt'])

function itemLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(#\s*)?([a-z_][a-z0-9_]*)=,(.*)$/i)
    if (!match) continue
    const slot = match[2]!.toLowerCase()
    if (COSMETIC.has(slot)) continue
    lines.push(`${match[2]}=,${match[3]}`)
  }
  return lines
}

test('every item line round-trips byte-identically', () => {
  const originals = itemLines(raw)
  assert.ok(originals.length > 100, `expected a full profile, found ${originals.length} item lines`)
  const emitted = new Set([...profile.equipped, ...profile.bagItems].map((c) => emitItemString(c.item)))
  const missing = originals.filter((line) => !emitted.has(line))
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} of ${originals.length} lines did not round-trip`)
})

test('unknown tokens survive a round trip', () => {
  // content_tuning and crafted_stats are not modelled as fields; they must come
  // back out anyway, in their original order.
  const crafted = profile.equipped.find((c) => c.item.id === 244582)
  assert.ok(crafted, 'fixture crafted legs missing')
  const line = emitItemString(crafted.item)
  assert.match(line, /content_tuning=3615/)
  assert.match(line, /crafted_stats=40\/32/)
  assert.match(line, /crafting_quality=5/)
  assert.ok(raw.includes(line), 'the re-emitted line is not present in the source verbatim')
})

test('physical copies of one item id are preserved, not deduplicated', () => {
  const all = [...profile.equipped, ...profile.bagItems]
  const byId = new Map<number, number>()
  for (const c of all) byId.set(c.item.id, (byId.get(c.item.id) ?? 0) + 1)
  const duplicated = [...byId].filter(([, n]) => n > 1)
  assert.ok(duplicated.length > 0, 'fixture has no duplicate item ids to check')
  // Duplicates must be distinct objects with their own tokens, or Top Gear
  // cannot offer the same item at two levels.
  for (const [id] of duplicated) {
    const copies = all.filter((c) => c.item.id === id)
    const strings = new Set(copies.map((c) => emitItemString(c.item)))
    assert.ok(
      strings.size > 1 || copies.length === new Set(copies).size,
      `copies of ${id} collapsed into one object`
    )
  }
})

test('the same item id at two levels stays two candidates', () => {
  // 271486 is equipped at 334 and in bags at 308; the hover-stat work depends
  // on these remaining separately addressable.
  const variants = [...profile.equipped, ...profile.bagItems].filter((c) => c.item.id === 271486)
  assert.equal(variants.length, 2)
  assert.notEqual(variants[0]!.ilvl, variants[1]!.ilvl)
  assert.notEqual(emitItemString(variants[0]!.item), emitItemString(variants[1]!.item))
})

test('header, checksum and saved loadouts are parsed', () => {
  assert.equal(profile.className, 'shaman')
  assert.equal(profile.spec, 'elemental')
  assert.ok(profile.characterName)
  assert.ok(profile.checksum, 'no addon checksum parsed')
  assert.ok(profile.header.wowBuild, 'no wow build in the header')
  assert.ok(profile.savedLoadouts.length > 1, 'saved loadouts not parsed')
  // Every loadout needs a talent string, or the Loadouts tab has nothing to sim.
  for (const loadout of profile.savedLoadouts) assert.ok(loadout.talents, `${loadout.name} has no talents`)
})

test('parsing is pure: it does not mutate the source or its own output', () => {
  const before = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
  const first = parseAddonProfile(before)
  const second = parseAddonProfile(before)
  assert.equal(
    first.equipped.map((c) => emitItemString(c.item)).join('\n'),
    second.equipped.map((c) => emitItemString(c.item)).join('\n')
  )
  assert.equal(before, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
})
