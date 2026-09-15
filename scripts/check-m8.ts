/** Real end-to-end check that a declared item reaches simc. */
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { describeCandidates, runTopGear } from '../src/core/topgear/funnel.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const p = parseAddonProfile(raw)
const owned = describeCandidates(p).filter((c) => c.source !== 'equipped' && c.supported)

// A trinket the character does not own, at a level above anything equipped.
const hypothetical = [
  { itemString: 'trinket1=,id=251785,bonus_id=6652/12843,ilevel=350', label: 'Hypothetical Libram 350' },
  { itemString: 'legs=,id=244582,bonus_id=12214/13667,crafting_quality=5,ilevel=350',
    label: 'Hypothetical Crafted Legs (plain)', embellished: false },
  { itemString: 'garbage in', label: 'Should be rejected' }
]

const r = await runTopGear(raw, {
  selectedIds: owned.slice(0, 6).map((c) => c.id),
  budgetSeconds: 60,
  threads: Math.max(1, availableParallelism() - 2),
  fightSeconds: 300,
  targets: 1,
  hypothetical
}, { simcPath: 'vendor/simc/simc.exe' })

console.log(`combinations ${BigInt(r.combinationCount).toLocaleString()} · shortlisted ${r.stageOneSimulated} · ${(r.durationMs / 1000).toFixed(1)}s`)
console.log(`\naccepted (${r.hypotheticalAccepted.length}):`)
for (const h of r.hypotheticalAccepted) {
  console.log(`  ${h.name} [${h.slot}] embellished=${h.embellished}`)
}
console.log(`rejected (${r.hypotheticalRejected.length}):`)
for (const h of r.hypotheticalRejected) console.log(`  "${h.itemString}" — ${h.reason}`)

console.log(`\nbaseline ${Math.round(r.baseline.dps.mean).toLocaleString()}`)
const winner = r.ranking[0]
console.log(`best     ${Math.round(winner.dps).toLocaleString()} (${winner.delta > 0 ? '+' : ''}${Math.round(winner.delta)})`)
const usedHypothetical = r.ranking.some((row) =>
  row.overrides.some((o) => o.includes('ilevel=350')))
console.log(`\nany ranked set uses a hypothetical item? ${usedHypothetical ? 'YES' : 'no'}`)
