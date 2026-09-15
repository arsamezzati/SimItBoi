import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { compareLoadouts, distinctLoadouts } from '../src/core/topgear/loadouts.ts'

const p = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
const { entries, skipped } = distinctLoadouts(p)
console.log(`${p.savedLoadouts.length} saved loadouts -> ${entries.length} distinct builds` +
  (skipped.length ? ` (${skipped.length} skipped)` : ''))

const r = await compareLoadouts(p, {
  simcPath: 'vendor/simc/simc.exe',
  threads: Math.max(1, availableParallelism() - 2),
  targetError: 0.15,
  fightSeconds: 300
})

console.log(`\nbaseline (current talents): ${Math.round(r.baselineDps).toLocaleString()} ± ${Math.round(r.baselineError)}\n`)
console.log('  DPS       change        names')
for (const x of r.results) {
  const sign = x.delta > 0 ? '+' : ''
  const change = x.isCurrent ? 'current' : `${sign}${Math.round(x.delta)} (${sign}${x.deltaPct.toFixed(2)}%)`
  const noise = !x.isCurrent && x.withinNoise ? ' ~noise' : ''
  console.log(`  ${Math.round(x.dps).toLocaleString().padStart(8)}  ${change.padEnd(18)}${x.names.join(', ')}${noise}`)
}
console.log(`\n${(r.durationMs / 1000).toFixed(1)}s`)
