import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { runSim, probeVersion, compareSimcBuild } from '../src/core/simc/runner.ts'

const simcPath = 'vendor/simc/simc.exe'
const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const profile = parseAddonProfile(raw)

const version = await probeVersion(simcPath)
console.log('simc build:', version?.build, '| WoW', version?.wowBuild)

const req = profile.header.requiresSimcBuild
if (req && version) {
  const cmp = compareSimcBuild(version.build, req)
  console.log(`version gate: requires ${req}, have ${version.build} ->`, cmp >= 0 ? 'OK' : 'TOO OLD')
}

let ticks = 0
const res = await runSim({
  simcPath,
  input: `${profile.raw}\niterations=500\nthreads=8\n`,
  onProgress: (p) => {
    ticks++
    if (ticks % 4 === 0) process.stdout.write(`\r  ${p.phase} ${p.completed}/${p.total} (${Math.round(p.fraction*100)}%) ${Math.round(p.throughput)} dps   `)
  }
})
process.stdout.write('\n')

const player = (res.json as any).sim.players[0]
const dps = player.collected_data.dps
console.log('progress callbacks fired:', ticks)
console.log('player:', player.name)
console.log('DPS:', Math.round(dps.mean).toLocaleString(), '±', Math.round(dps.mean_std_dev ?? 0))
console.log('gear slots parsed:', Object.keys(player.gear).length)
console.log('duration:', (res.durationMs/1000).toFixed(2) + 's')
