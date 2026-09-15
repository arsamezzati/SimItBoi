import { readFileSync } from 'node:fs'
import { parseAddonProfile, emitItemString } from '../src/core/parser/addonProfile.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const p = parseAddonProfile(raw)

console.log('character   ', p.characterName, '|', p.className, p.spec, 'lvl', p.level, p.race)
console.log('header      ', p.header.characterName, '|', p.header.region + '/' + p.header.realm,
            '| addon', p.header.addonVersion, '| wow', p.header.wowBuild,
            '| requires', p.header.requiresSimcBuild)
console.log('checksum    ', p.checksum)
console.log('loadouts    ', p.savedLoadouts.length)
console.log('equipped    ', p.equipped.length)
console.log('bag items   ', p.bagItems.length)
console.log('extra lines ', p.extraProfileLines.map((t) => t.key).join(', '))
console.log('addl info   ', Object.keys(p.additionalInfo).join(', '))
console.log('warnings    ', p.warnings.length ? p.warnings : '(none)')

console.log('\n--- slot class distribution (bags) ---')
const bySlot: Record<string, number> = {}
for (const c of p.bagItems) bySlot[c.slotClass] = (bySlot[c.slotClass] ?? 0) + 1
console.log(bySlot)

console.log('\n--- ROUND-TRIP CHECK ---')
let checked = 0, failed = 0
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^(#\s*)?([a-z_][a-z0-9_]*)=,(.*)$/i)
  if (!m) continue
  const slot = m[2]
  if (slot === 'tabard' || slot === 'shirt') continue
  const original = `${slot}=,${m[3]}`
  const all = [...p.equipped, ...p.bagItems]
  const match = all.find((c) => emitItemString(c.item) === original)
  checked++
  if (!match) { failed++; if (failed <= 3) console.log('  MISMATCH:', original.slice(0, 90)) }
}
console.log(`round-tripped ${checked - failed}/${checked} item lines byte-identically`)
