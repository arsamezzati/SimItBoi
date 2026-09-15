/**
 * Verifies the guided catalog against the real binary: every upgrade rung the
 * season inventory claims must be the item level simc actually resolves. Run:
 * npm run check:catalog
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveCatalog, catalogItem } from '../src/core/data/catalog.ts'
import { runSim } from '../src/core/simc/runner.ts'
const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
let checked = 0
const GEAR_KEY: Record<string, string> = { wrist: 'wrists', shoulder: 'shoulders' }
// 268265 (Aqirbane Reliquary, from Ula'tek) carries the Mythic final-boss 344
// variant as well as its rungs, so that claim is measured here too.
for (const id of [250214, 271483, 158368, 268265]) {
  const item = catalogItem(id)
  assert.ok(item, `item ${id} is missing from the guided catalog`)
  assert.ok(item.variants.length, `item ${id} has no upgrade rungs`)
  // Every track, not just the top two: a wrong rung anywhere is a wrong item.
  for (const variant of item.variants) {
    const h = resolveCatalog({ itemId: id, track: variant.track, ilvl: variant.ilvl }, 'shaman')
    const r = await runSim({ simcPath: 'vendor/simc/simc.exe', input: `${raw}\n${h.itemString}\niterations=1\nthreads=1\nmax_time=10\n`, leanReport: true })
    const slot = h.itemString.split('=')[0]!
    const gear = (r.json as any).sim.players[0].gear[GEAR_KEY[slot] ?? slot]
    assert.equal(gear.ilevel, variant.ilvl, `${id} ${variant.track}: ${JSON.stringify(gear)}`)
    assert.ok(gear.encoded_item.includes(`id=${id}`))
    checked++
  }
  console.log(`${item.name} #${id}: ${item.variants.length} rungs all resolve to their claimed item level`)
}
console.log(`
${checked} upgrade rungs verified against the real binary.`)
