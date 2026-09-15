import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'

const p = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
const all = [...p.equipped, ...p.bagItems]

// Which item IDs show up at CURRENT gear level (>= 280)?
const current = all.filter((c) => c.ilvl >= 280).sort((a, b) => a.item.id - b.item.id)
console.log(`items at ilvl >= 280: ${current.length}`)
console.log('\nid       ilvl  item')
for (const c of current) {
  const era = c.item.id < 200000 ? '  <-- OLD ID, current ilvl' : ''
  console.log(`${String(c.item.id).padEnd(8)} ${String(c.ilvl).padEnd(5)} ${c.name}${era}`)
}
const oldIds = current.filter((c) => c.item.id < 200000)
console.log(`\n${oldIds.length} of ${current.length} current-ilvl items have pre-Midnight ids`)
console.log(`id range of current-ilvl gear: ${current[0].item.id} .. ${current[current.length-1].item.id}`)
