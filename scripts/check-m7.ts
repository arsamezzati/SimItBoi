import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { describeCandidates, runTopGear } from '../src/core/topgear/funnel.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const candidates = describeCandidates(parseAddonProfile(raw))
let lastStage = ''
const result = await runTopGear(raw, {
  selectedIds: candidates.filter((c) => c.supported && c.ilvl >= 281).map((c) => c.id), budgetSeconds: 15
}, { simcPath: 'vendor/simc/simc.exe', onProgress: (p) => {
  if (p.stage !== lastStage) { lastStage = p.stage; console.log(`${p.stage}: ${p.detail}`) }
} })
assert.ok(result.ranking.length > 0)
assert.ok(result.stageOneSimulated > 0)
assert.ok(result.baseline.abilities.length > 0)
for (const row of result.ranking) {
  assert.ok(row.report.abilities.length > 0)
  assert.ok(row.report.gear.length >= 15)
  assert.equal(row.delta, row.dps - result.baseline.dps.mean)
}
mkdirSync('data', { recursive: true })
writeFileSync('data/m7-smoke.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify({ count: result.combinationCount, shortlisted: result.shortlisted,
  simulated: result.stageOneSimulated, detailed: result.detailedSimulated, seconds: result.durationMs / 1000,
  baseline: result.baseline.dps.mean, best: result.ranking[0].dps, rejected: result.rejected.length }, null, 2))
