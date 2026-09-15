import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { itemStatKey, packBySlot, probeItemStats } from '../src/core/data/itemStats.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { filterCandidates } from '../src/core/topgear/prepass.ts'
import { extractReport } from '../src/core/report/extract.ts'
import { describeCandidates } from '../src/core/topgear/funnel.ts'

const profile = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

test('packing never puts two items of one slot in the same round', () => {
  const rounds = packBySlot(filterCandidates(profile()))
  for (const round of rounds) {
    const slots = round.map((c) => c.slotClass)
    assert.equal(new Set(slots).size, slots.length, 'a round would overwrite its own slot')
  }
})

test('packing loses nothing', () => {
  const candidates = filterCandidates(profile())
  const rounds = packBySlot(candidates)
  assert.equal(rounds.flat().length, candidates.length)
  assert.deepEqual(new Set(rounds.flat()), new Set(candidates))
})

test('packing is far cheaper than one run per item', () => {
  const candidates = filterCandidates(profile())
  const rounds = packBySlot(candidates)
  // The whole point: ~15 slots means rounds grow with the busiest slot, not N.
  assert.ok(rounds.length < candidates.length / 3,
    `${rounds.length} rounds for ${candidates.length} candidates is no better than probing one at a time`)
})

test('an empty candidate list produces no rounds', () => {
  assert.deepEqual(packBySlot([]), [])
})

test('physical copies keep distinct ids while identical variants share a stat key', () => {
  const copies = describeCandidates(profile()).filter((candidate) => candidate.name === 'Jangling Felpaulets' && candidate.ilvl === 311)
  assert.equal(copies.length, 2)
  assert.notEqual(copies[0]!.id, copies[1]!.id)
  assert.equal(copies[0]!.statKey, copies[1]!.statKey)
})

test('exact keys distinguish item 271486 at 334 and 308 while preserving tokens', async () => {
  const p = profile()
  const variants = filterCandidates(p, { preserveVariants: true }).filter((candidate) => candidate.item.id === 271486)
  assert.equal(variants.length, 2)
  const keys = variants.map(itemStatKey)
  assert.equal(new Set(keys).size, 2)
  assert.ok(keys.some((key) => key.includes('12854')))
  assert.ok(keys.some((key) => key.includes('12838')))

  const results = await probeItemStats(p, variants, {
    simcPath: 'unused',
    run: async ({ input }) => {
      const override = input.trim().split(/\r?\n/).filter((line) => line.startsWith('chest=')).at(-1)!
      const ilevel = override.includes('12854') ? 334 : 308
      return {
        json: { sim: { players: [{ gear: { chest: {
          encoded_item: 'fanged_raiment,id=271486', ilevel, stamina: ilevel
        } } }] } },
        stdout: '', exitCode: 0, durationMs: 1, version: null
      }
    }
  })
  assert.deepEqual(keys.map((key) => results.get(key)), [
    { status: 'available', ilvl: 334, stats: [{ name: 'Stamina', value: 334 }] },
    { status: 'available', ilvl: 308, stats: [{ name: 'Stamina', value: 308 }] }
  ])
})

test('a requested paired slot cannot be overwritten by an inherited copy', async () => {
  const p = profile()
  const ring = p.equipped.find((candidate) => candidate.item.id === 268252)!
  const results = await probeItemStats(p, [ring], {
    simcPath: 'unused',
    run: async () => ({
      json: { sim: { players: [{ gear: {
        finger1: { encoded_item: 'requested,id=268252', stamina: 111 },
        finger2: { encoded_item: 'inherited,id=268252', stamina: 999 }
      } }] } },
      stdout: '', exitCode: 0, durationMs: 1, version: null
    })
  })
  assert.deepEqual(results.get(itemStatKey(ring)), {
    status: 'available', stats: [{ name: 'Stamina', value: 111 }]
  })
})

test('missing output and failed rounds have explicit states', async () => {
  const p = profile()
  const head = p.equipped.find((candidate) => candidate.slotClass === 'head')!
  const missing = await probeItemStats(p, [head], {
    simcPath: 'unused',
    run: async () => ({ json: { sim: { players: [{ gear: {} }] } }, stdout: '', exitCode: 0, durationMs: 1, version: null })
  })
  assert.equal(missing.get(itemStatKey(head))?.status, 'missing')

  const failed = await probeItemStats(p, [head], {
    simcPath: 'unused',
    run: async () => { throw new Error('packed round rejected') }
  })
  assert.deepEqual(failed.get(itemStatKey(head)), { status: 'failed', reason: 'packed round rejected' })
})

test('report extraction keeps per-item stats rather than discarding them', () => {
  // Mirrors the shape simc emits; extraction used to drop everything but ilvl.
  const report = extractReport({
    sim: {
      players: [{
        name: 'T',
        collected_data: { dps: { mean: 1 }, dmg: { mean: 1 }, fight_length: { mean: 300 } },
        gear: {
          head: {
            name: 'serpent_crown', ilevel: 321, encoded_item: 'serpent_crown,id=271483',
            stamina: 3369, crit_rating: 75, mastery_rating: 116, agiint: 167, bogus_zero: 0
          }
        }
      }]
    }
  })!
  const head = report.gear.find((g) => g.slot === 'Head')!
  assert.equal(head.id, 271483)
  assert.equal(head.ilvl, 321)
  const names = head.stats!.map((s) => s.name)
  assert.deepEqual(names, ['Stamina', 'Agi/Int', 'Mastery Rating', 'Crit Rating'], 'sorted by value, labelled')
  assert.ok(!names.includes('Bogus Zero'), 'zero-valued stats are noise')
  assert.ok(!names.includes('Name') && !names.includes('Ilevel'), 'metadata is not a stat')
  assert.equal(head.encoded, 'serpent_crown,id=271483')
})
