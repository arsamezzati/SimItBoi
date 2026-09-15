import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { runPrepass, filterCandidates } from '../src/core/topgear/prepass.ts'

const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

const all = [...profile.equipped, ...profile.bagItems]
const filtered = filterCandidates(profile)
console.log(`candidates: ${all.length} raw -> ${filtered.length} after ilvl floor + dedupe`)
const bySlot: Record<string, number> = {}
for (const c of filtered) bySlot[c.slotClass] = (bySlot[c.slotClass] ?? 0) + 1
console.log('per slot:', bySlot)

const r = await runPrepass(profile, { simcPath: 'vendor/simc/simc.exe', iterations: 300, threads: 8 })

console.log(`\nbaseline: ${Math.round(r.baselineDps).toLocaleString()} DPS`)
console.log('stat weights:', Object.entries(r.weights).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  '))
console.log(`\nprofilesets returned: ${r.deltas.length}/${r.candidates.length}`)
console.log('\nTop upgrades:')
for (const d of r.deltas.slice(0, 8)) {
  const sign = d.delta >= 0 ? '+' : ''
  console.log(`  ${sign}${Math.round(d.delta).toString().padStart(6)}  ±${Math.round(d.error).toString().padEnd(4)} ${d.candidate.slotClass.padEnd(10)} ${d.candidate.name} (${d.candidate.ilvl})`)
}
console.log('\nWorst:')
for (const d of r.deltas.slice(-3)) {
  console.log(`  ${Math.round(d.delta).toString().padStart(7)}  ${d.candidate.slotClass.padEnd(10)} ${d.candidate.name} (${d.candidate.ilvl})`)
}
console.log(`\nprepass wall time: ${(r.durationMs / 1000).toFixed(1)}s`)

if (r.rejected.length > 0) {
  console.log('\nRejected by simc (unequippable):')
  for (const x of r.rejected) console.log(`  ${x.candidate.name} (${x.candidate.slotClass}) — ${x.reason}`)
}
