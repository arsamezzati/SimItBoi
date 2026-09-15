import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { solveTopGear, combinationOverrides } from '../src/core/topgear/solver.ts'
import { runSim } from '../src/core/simc/runner.ts'

const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
const start = performance.now()
const result = await solveTopGear(profile, {
  shortlistSize: 12,
  // Structural smoke test only. M7 supplies scores from simulations/stat probes.
  scoreItem: (c) => c.ilvl
})
console.log(`M6: ${result.combinationCount} supported combinations, ${result.shortlist.length} shortlisted in ${(performance.now() - start).toFixed(0)} ms`)
console.log('Tier buckets:', result.buckets.map((b) => ({ tier: b.tier, count: String(b.count) })))
console.log('Metadata coverage:', result.validation, result.warnings)
console.log('Excluded:', result.excluded.length, '| Peak states:', result.peakStates)
assert.ok(result.combinationCount > 0n)
assert.ok(result.shortlist.some((c) => Object.values(c.tier).includes(4)))
if (process.argv.includes('--simc')) {
  for (const wantOffHand of [false, true]) {
    // Separate selection proves paired swaps remain available regardless of score.
    const choices = await solveTopGear(profile, {
      shortlistSize: 12, scoreItem: (c) => c.ilvl,
      scoreWeapons: (gear) => (Boolean(gear.off_hand) === wantOffHand ? 100_000 : 0)
    })
    const combo = choices.shortlist[0]
    assert.equal(Boolean(combo.gear.off_hand), wantOffHand)
    const run = await runSim({ simcPath: 'vendor/simc/simc.exe',
      // Deliberately start with a shield, proving that '=none' removes inherited gear.
      input: `${profile.raw}\noff_hand=,id=159664\n${combinationOverrides(combo).join('\n')}\niterations=1\nthreads=${Math.max(1, availableParallelism() - 2)}\n`, leanReport: true })
    const json = run.json as { sim: { players: Array<{ gear: Record<string, { encoded_item?: string }> }> } }
    const gear = json.sim.players[0].gear
    assert.equal(Boolean(gear.off_hand?.encoded_item), wantOffHand)
    assert.ok(gear.main_hand.encoded_item?.includes(`id=${combo.gear.main_hand!.item.id},`))
    console.log(`simc accepted ${wantOffHand ? '1H + off-hand' : '2H + empty off-hand'} (${run.durationMs} ms)`)
  }
}
