import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { distinctLoadouts, buildLoadoutInput, compareLoadouts } from '../src/core/topgear/loadouts.ts'

const fixture = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

test('duplicate builds collapse to one entry listing every saved name', () => {
  const p = fixture()
  const { entries } = distinctLoadouts(p)

  // The fixture saves 14 loadouts, several of which are the same build.
  assert.equal(p.savedLoadouts.length, 14)
  assert.ok(entries.length < 14 + 1, 'duplicates should collapse')

  const talents = entries.map((e) => e.talents)
  assert.equal(new Set(talents).size, talents.length, 'entries must be distinct')

  const shared = entries.find((e) => e.names.length > 1)
  assert.ok(shared, 'fixture #1 has at least one build saved under several names')
})

test('the active talents are included exactly once and marked current', () => {
  const p = fixture()
  const { entries } = distinctLoadouts(p)
  const current = entries.filter((e) => e.isCurrent)
  assert.equal(current.length, 1)
  assert.equal(current[0].talents, p.talents)
})

test('a saved loadout identical to the active build does not duplicate it', () => {
  const p = parseAddonProfile(
    ['shaman="X"', 'level=90', 'spec=elemental', 'talents=AAAA', '# Saved Loadout: same', '# talents=AAAA', ''].join('\n')
  )
  const { entries } = distinctLoadouts(p)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].isCurrent, true)
  assert.deepEqual(entries[0].names, ['Current', 'same'])
})

test('loadouts with no talent string are skipped, not silently dropped', () => {
  const p = parseAddonProfile(
    ['shaman="X"', 'level=90', 'talents=AAAA', '# Saved Loadout: empty', '# talents=', ''].join('\n')
  )
  const { entries, skipped } = distinctLoadouts(p)
  assert.equal(entries.length, 1)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].name, 'empty')
})

test('every distinct loadout becomes exactly one profileset override', () => {
  const p = fixture()
  const { entries } = distinctLoadouts(p)
  const input = buildLoadoutInput(p, entries, { threads: 8, iterations: 500 })

  const overrides = [...input.matchAll(/^profileset\."(l\d+)"=talents=(.+)$/gm)]
  assert.equal(overrides.length, entries.length)
  assert.equal(new Set(overrides.map((m) => m[1])).size, entries.length, 'ids must be unique')
  for (const [i, entry] of entries.entries()) {
    assert.equal(overrides[i][2], entry.talents)
  }
})

test('the batch sets the measured work-thread option', () => {
  const p = fixture()
  const { entries } = distinctLoadouts(p)
  const input = buildLoadoutInput(p, entries, { threads: 8, iterations: 500 })
  assert.match(input, /profileset_work_threads=\d+/)
  assert.match(input, /profileset_metric=dps/)
})

test('target_error mode does not also pin a small iteration count', () => {
  const p = fixture()
  const { entries } = distinctLoadouts(p)
  const input = buildLoadoutInput(p, entries, { targetError: 0.1 })
  assert.match(input, /target_error=0\.1/)
  assert.match(input, /iterations=1000000/)
})

test('a profile with no talents at all is rejected rather than simmed empty', async () => {
  const p = parseAddonProfile(['shaman="X"', 'level=90', ''].join('\n'))
  const { entries } = distinctLoadouts(p)
  assert.equal(entries.length, 0)
})

const fakeRun = (results: Array<{ name: string; mean?: number; mean_error?: number }>) => async () => ({
  json: { sim: { profilesets: { results } } }, durationMs: 1, stdout: '', exitCode: 0, version: null
})

test('missing current baseline is fatal instead of becoming zero DPS', async () => {
  await assert.rejects(compareLoadouts(fixture(), { simcPath: 'unused', run: fakeRun([{ name: 'l1', mean: 100 }]) }), /no result for the current/)
})

test('invalid current baseline is fatal and invalid alternatives are skipped', async () => {
  await assert.rejects(compareLoadouts(fixture(), { simcPath: 'unused', run: fakeRun([{ name: 'l0', mean: Number.NaN }]) }), /invalid numerical/)
  const result = await compareLoadouts(fixture(), { simcPath: 'unused', run: fakeRun([
    { name: 'l0', mean: 1000, mean_error: 10 }, { name: 'l1', mean: Number.POSITIVE_INFINITY, mean_error: 1 }
  ]) })
  assert.equal(result.baselineDps, 1000)
  assert.ok(result.skipped.some((entry) => entry.reason.includes('valid numerical')))
})
