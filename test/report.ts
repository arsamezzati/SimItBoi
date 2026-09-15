import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { runSim } from '../src/core/simc/runner.ts'
import { extractReport } from '../src/core/report/extract.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const profile = parseAddonProfile(raw)
const res = await runSim({ simcPath: 'vendor/simc/simc.exe', input: `${profile.raw}\niterations=500\nthreads=8\n` })
const r = extractReport(res.json)!

console.log(`${r.character.name} — ${r.character.race} lvl ${r.character.level}`)
console.log(`DPS ${Math.round(r.dps.mean).toLocaleString()} ± ${Math.round(r.dps.error)} (${r.dps.errorPct.toFixed(2)}%)`)
console.log(`fight ${r.fightLength.toFixed(1)}s · ${r.iterations} iterations · total dmg ${Math.round(r.totalDamage).toLocaleString()}`)

console.log('\nDamage breakdown:')
for (const a of r.abilities.slice(0, 8)) {
  const bar = '█'.repeat(Math.round(a.share * 40))
  console.log(`  ${a.name.padEnd(24)} ${(a.share*100).toFixed(1).padStart(5)}%  ${bar}`)
}
const sum = r.abilities.reduce((s, a) => s + a.share, 0)
console.log(`  ${'TOTAL'.padEnd(24)} ${(sum*100).toFixed(2).padStart(5)}%   <- must be ~100`)

console.log('\nTop buff uptimes:')
for (const b of r.buffs.slice(0, 6)) console.log(`  ${b.name.padEnd(28)} ${b.uptime.toFixed(1)}%`)
console.log(`\ngear rows: ${r.gear.length}  (top: ${r.gear[0].name} ${r.gear[0].ilvl})`)
